/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {AotCompiler, AotCompilerHost, AotCompilerOptions, EmitterVisitorContext, GeneratedFile, MessageBundle, NgAnalyzedModules, ParseSourceSpan, Serializer, TypeScriptEmitter, Xliff, Xliff2, Xmb, core, createAotCompiler, getParseErrors, isSyntaxError, toTypeScript} from '@angular/compiler';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

import {BaseAotCompilerHost} from '../compiler_host';
import {TypeCheckHost, translateDiagnostics} from '../diagnostics/translate_diagnostics';
import {createBundleIndexHost} from '../metadata/index';

import {CompilerHost, CompilerOptions, CustomTransformers, DEFAULT_ERROR_CODE, Diagnostic, EmitFlags, Program, SOURCE, TsEmitArguments, TsEmitCallback} from './api';
import {LowerMetadataCache, getExpressionLoweringTransformFactory} from './lower_expressions';
import {getAngularEmitterTransformFactory} from './node_emitter_transform';
import {GENERATED_FILES} from './util';

const emptyModules: NgAnalyzedModules = {
  ngModules: [],
  ngModuleByPipeOrDirective: new Map(),
  files: []
};

const defaultEmitCallback: TsEmitCallback =
    ({program, targetSourceFile, writeFile, cancellationToken, emitOnlyDtsFiles,
      customTransformers}) =>
        program.emit(
            targetSourceFile, writeFile, cancellationToken, emitOnlyDtsFiles, customTransformers);


class AngularCompilerProgram implements Program {
  private tsProgram: ts.Program;
  private aotCompilerHost: AotCompilerHost;
  private compiler: AotCompiler;
  private srcNames: string[];
  private metadataCache: LowerMetadataCache;
  // Lazily initialized fields
  private _analyzedModules: NgAnalyzedModules|undefined;
  private _structuralDiagnostics: Diagnostic[] = [];
  private _stubs: GeneratedFile[]|undefined;
  private _stubFiles: string[]|undefined;
  private _programWithStubsHost: ts.CompilerHost&TypeCheckHost|undefined;
  private _programWithStubs: ts.Program|undefined;
  private _generatedFiles: GeneratedFile[]|undefined;
  private _generatedFileDiagnostics: Diagnostic[]|undefined;
  private _semanticDiagnostics: {ts: ts.Diagnostic[], ng: Diagnostic[]}|undefined;
  private _optionsDiagnostics: Diagnostic[] = [];

  constructor(
      private rootNames: string[], private options: CompilerOptions, private host: CompilerHost,
      oldProgram?: Program) {
    if (options.flatModuleOutFile) {
      const {host: bundleHost, indexName, errors} = createBundleIndexHost(options, rootNames, host);
      if (errors) {
        // TODO(tbosch): once we move MetadataBundler from tsc_wrapped into compiler_cli,
        // directly create ng.Diagnostic instead of using ts.Diagnostic here.
        this._optionsDiagnostics.push(...errors.map(e => ({
                                                      category: e.category,
                                                      messageText: e.messageText as string,
                                                      source: SOURCE,
                                                      code: DEFAULT_ERROR_CODE
                                                    })));
      } else {
        rootNames.push(indexName !);
        this.host = host = bundleHost;
      }
    }

    const oldTsProgram = oldProgram ? oldProgram.getTsProgram() : undefined;
    this.tsProgram = ts.createProgram(rootNames, options, host, oldTsProgram);
    this.srcNames =
        this.tsProgram.getSourceFiles()
            .map(sf => sf.fileName)
            .filter(f => !f.match(/\.ngfactory\.[\w.]+$|\.ngstyle\.[\w.]+$|\.ngsummary\.[\w.]+$/));
    this.metadataCache = new LowerMetadataCache({quotedNames: true}, !!options.strictMetadataEmit);
    this.aotCompilerHost =
        new AotCompilerHostImpl(this.tsProgram, options, host, this.metadataCache);

    const aotOptions = getAotCompilerOptions(options);
    this.compiler = createAotCompiler(this.aotCompilerHost, aotOptions).compiler;
  }

  // Program implementation
  getTsProgram(): ts.Program { return this.programWithStubs; }

  getTsOptionDiagnostics(cancellationToken?: ts.CancellationToken) {
    return this.tsProgram.getOptionsDiagnostics(cancellationToken);
  }

  getNgOptionDiagnostics(cancellationToken?: ts.CancellationToken): Diagnostic[] {
    return [...this._optionsDiagnostics, ...getNgOptionDiagnostics(this.options)];
  }

  getTsSyntacticDiagnostics(sourceFile?: ts.SourceFile, cancellationToken?: ts.CancellationToken):
      ts.Diagnostic[] {
    return this.tsProgram.getSyntacticDiagnostics(sourceFile, cancellationToken);
  }

  getNgStructuralDiagnostics(cancellationToken?: ts.CancellationToken): Diagnostic[] {
    return this.structuralDiagnostics;
  }

  getTsSemanticDiagnostics(sourceFile?: ts.SourceFile, cancellationToken?: ts.CancellationToken):
      ts.Diagnostic[] {
    return this.semanticDiagnostics.ts;
  }

  getNgSemanticDiagnostics(fileName?: string, cancellationToken?: ts.CancellationToken):
      Diagnostic[] {
    const compilerDiagnostics = this.generatedFileDiagnostics;

    // If we have diagnostics during the parser phase the type check phase is not meaningful so skip
    // it.
    if (compilerDiagnostics && compilerDiagnostics.length) return compilerDiagnostics;
    return this.semanticDiagnostics.ng;
  }

  loadNgStructureAsync(): Promise<void> {
    return this.compiler.analyzeModulesAsync(this.rootNames)
        .catch(this.catchAnalysisError.bind(this))
        .then(analyzedModules => {
          if (this._analyzedModules) {
            throw new Error('Angular structure loaded both synchronously and asynchronsly');
          }
          this._analyzedModules = analyzedModules;
        });
  }

  emit({emitFlags = EmitFlags.Default, cancellationToken, customTransformers,
        emitCallback = defaultEmitCallback}: {
    emitFlags?: EmitFlags,
    cancellationToken?: ts.CancellationToken,
    customTransformers?: CustomTransformers,
    emitCallback?: TsEmitCallback
  }): ts.EmitResult {
    if (emitFlags & EmitFlags.I18nBundle) {
      const locale = this.options.i18nOutLocale || null;
      const file = this.options.i18nOutFile || null;
      const format = this.options.i18nOutFormat || null;
      const bundle = this.compiler.emitMessageBundle(this.analyzedModules, locale);
      i18nExtract(format, file, this.host, this.options, bundle);
    }
    if (emitFlags & (EmitFlags.JS | EmitFlags.DTS | EmitFlags.Metadata | EmitFlags.Summary)) {
      return emitCallback({
        program: this.programWithStubs,
        host: this.host,
        options: this.options,
        targetSourceFile: undefined,
        writeFile:
            createWriteFileCallback(emitFlags, this.host, this.metadataCache, this.generatedFiles),
        cancellationToken,
        emitOnlyDtsFiles: (emitFlags & (EmitFlags.DTS | EmitFlags.JS)) == EmitFlags.DTS,
        customTransformers: this.calculateTransforms(customTransformers)
      });
    }
    return {emitSkipped: true, diagnostics: [], emittedFiles: []};
  }

  // Private members
  private get analyzedModules(): NgAnalyzedModules {
    return this._analyzedModules || (this._analyzedModules = this.analyzeModules());
  }

  private get structuralDiagnostics(): Diagnostic[] {
    return this.analyzedModules && this._structuralDiagnostics;
  }

  private get stubs(): GeneratedFile[] {
    return this._stubs || (this._stubs = this.generateStubs());
  }

  private get stubFiles(): string[] {
    return this._stubFiles ||
        (this._stubFiles = this.stubs.reduce((files: string[], generatedFile) => {
             if (generatedFile.source || (generatedFile.stmts && generatedFile.stmts.length)) {
               return [...files, generatedFile.genFileUrl];
             }
             return files;
           }, []));
  }

  private get programWithStubsHost(): ts.CompilerHost&TypeCheckHost {
    return this._programWithStubsHost || (this._programWithStubsHost = createProgramWithStubsHost(
                                              this.stubs, this.tsProgram, this.host));
  }

  private get programWithStubs(): ts.Program {
    return this._programWithStubs || (this._programWithStubs = this.createProgramWithStubs());
  }

  private get generatedFiles(): GeneratedFile[] {
    return this._generatedFiles || (this._generatedFiles = this.generateFiles());
  }

  private get generatedFileDiagnostics(): Diagnostic[]|undefined {
    return this.generatedFiles && this._generatedFileDiagnostics !;
  }

  private get semanticDiagnostics(): {ts: ts.Diagnostic[], ng: Diagnostic[]} {
    return this._semanticDiagnostics ||
        (this._semanticDiagnostics = this.generateSemanticDiagnostics());
  }

  private calculateTransforms(customTransformers?: CustomTransformers): ts.CustomTransformers {
    const beforeTs: ts.TransformerFactory<ts.SourceFile>[] = [];
    if (!this.options.disableExpressionLowering) {
      beforeTs.push(getExpressionLoweringTransformFactory(this.metadataCache));
    }
    if (!this.options.skipTemplateCodegen) {
      beforeTs.push(getAngularEmitterTransformFactory(this.generatedFiles));
    }
    if (customTransformers && customTransformers.beforeTs) {
      beforeTs.push(...customTransformers.beforeTs);
    }
    const afterTs = customTransformers ? customTransformers.afterTs : undefined;
    return {before: beforeTs, after: afterTs};
  }

  private catchAnalysisError(e: any): NgAnalyzedModules {
    if (isSyntaxError(e)) {
      const parserErrors = getParseErrors(e);
      if (parserErrors && parserErrors.length) {
        this._structuralDiagnostics =
            parserErrors.map<Diagnostic>(e => ({
                                           messageText: e.contextualMessage(),
                                           category: ts.DiagnosticCategory.Error,
                                           span: e.span,
                                           source: SOURCE,
                                           code: DEFAULT_ERROR_CODE
                                         }));
      } else {
        this._structuralDiagnostics = [{
          messageText: e.message,
          category: ts.DiagnosticCategory.Error,
          source: SOURCE,
          code: DEFAULT_ERROR_CODE
        }];
      }
      this._analyzedModules = emptyModules;
      return emptyModules;
    }
    throw e;
  }

  private analyzeModules() {
    try {
      return this.compiler.analyzeModulesSync(this.srcNames);
    } catch (e) {
      return this.catchAnalysisError(e);
    }
  }

  private generateStubs() {
    return this.options.skipTemplateCodegen ? [] : this.compiler.emitAllStubs(this.analyzedModules);
  }

  private generateFiles() {
    try {
      // Always generate the files if requested to ensure we capture any diagnostic errors but only
      // keep the results if we are not skipping template code generation.
      const result = this.compiler.emitAllImpls(this.analyzedModules);
      return this.options.skipTemplateCodegen ? [] : result;
    } catch (e) {
      if (isSyntaxError(e)) {
        this._generatedFileDiagnostics = [{
          messageText: e.message,
          category: ts.DiagnosticCategory.Error,
          source: SOURCE,
          code: DEFAULT_ERROR_CODE
        }];
        return [];
      }
      throw e;
    }
  }

  private createProgramWithStubs(): ts.Program {
    // If we are skipping code generation just use the original program.
    // Otherwise, create a new program that includes the stub files.
    return this.options.skipTemplateCodegen ?
        this.tsProgram :
        ts.createProgram(
            [...this.rootNames, ...this.stubFiles], this.options, this.programWithStubsHost);
  }

  private generateSemanticDiagnostics(): {ts: ts.Diagnostic[], ng: Diagnostic[]} {
    return translateDiagnostics(
        this.programWithStubsHost, this.programWithStubs.getSemanticDiagnostics());
  }
}

class AotCompilerHostImpl extends BaseAotCompilerHost<CompilerHost> {
  moduleNameToFileName(m: string, containingFile: string): string|null {
    return this.context.moduleNameToFileName(m, containingFile);
  }

  fileNameToModuleName(importedFile: string, containingFile: string): string|null {
    return this.context.fileNameToModuleName(importedFile, containingFile);
  }

  resourceNameToFileName(resourceName: string, containingFile: string): string|null {
    return this.context.resourceNameToFileName(resourceName, containingFile);
  }

  toSummaryFileName(fileName: string, referringSrcFileName: string): string {
    return this.context.toSummaryFileName(fileName, referringSrcFileName);
  }

  fromSummaryFileName(fileName: string, referringLibFileName: string): string {
    return this.context.fromSummaryFileName(fileName, referringLibFileName);
  }
}

export function createProgram(
    {rootNames, options, host, oldProgram}:
        {rootNames: string[], options: CompilerOptions, host: CompilerHost, oldProgram?: Program}):
    Program {
  return new AngularCompilerProgram(rootNames, options, host, oldProgram);
}

// Compute the AotCompiler options
function getAotCompilerOptions(options: CompilerOptions): AotCompilerOptions {
  let missingTranslation = core.MissingTranslationStrategy.Warning;

  switch (options.i18nInMissingTranslations) {
    case 'ignore':
      missingTranslation = core.MissingTranslationStrategy.Ignore;
      break;
    case 'error':
      missingTranslation = core.MissingTranslationStrategy.Error;
      break;
  }

  let translations: string = '';

  if (options.i18nInFile) {
    if (!options.i18nInLocale) {
      throw new Error(`The translation file (${options.i18nInFile}) locale must be provided.`);
    }
    translations = fs.readFileSync(options.i18nInFile, 'utf8');
  } else {
    // No translations are provided, ignore any errors
    // We still go through i18n to remove i18n attributes
    missingTranslation = core.MissingTranslationStrategy.Ignore;
  }

  return {
    locale: options.i18nInLocale,
    i18nFormat: options.i18nInFormat || options.i18nOutFormat, translations, missingTranslation,
    enableLegacyTemplate: options.enableLegacyTemplate,
    enableSummariesForJit: true,
    preserveWhitespaces: options.preserveWhitespaces,
    fullTemplateTypeCheck: options.fullTemplateTypeCheck,
  };
}

function writeMetadata(
    host: ts.CompilerHost, emitFilePath: string, sourceFile: ts.SourceFile,
    metadataCache: LowerMetadataCache, onError?: (message: string) => void) {
  if (/\.js$/.test(emitFilePath)) {
    const path = emitFilePath.replace(/\.js$/, '.metadata.json');

    // Beginning with 2.1, TypeScript transforms the source tree before emitting it.
    // We need the original, unmodified, tree which might be several levels back
    // depending on the number of transforms performed. All SourceFile's prior to 2.1
    // will appear to be the original source since they didn't include an original field.
    let collectableFile = sourceFile;
    while ((collectableFile as any).original) {
      collectableFile = (collectableFile as any).original;
    }

    const metadata = metadataCache.getMetadata(collectableFile);
    if (metadata) {
      const metadataText = JSON.stringify([metadata]);
      host.writeFile(path, metadataText, false, onError, [sourceFile]);
    }
  }
}

function writeNgSummaryJson(
    host: ts.CompilerHost, emitFilePath: string, sourceFile: ts.SourceFile,
    generatedFilesByName: Map<string, GeneratedFile>, onError?: (message: string) => void) {
  // Note: some files have an empty .ngfactory.js/.d.ts file but still need
  // .ngsummary.json files (e.g. directives / pipes).
  // We write the ngSummary when we try to emit the .ngfactory.js files
  // and not the regular .js files as the latter are not emitted when
  // we generate code for a npm library which ships .js / .d.ts / .metadata.json files.
  if (/\.ngfactory.js$/.test(emitFilePath)) {
    const emitPath = emitFilePath.replace(/\.ngfactory\.js$/, '.ngsummary.json');
    const genFilePath = sourceFile.fileName.replace(/\.ngfactory\.ts$/, '.ngsummary.json');
    const genFile = generatedFilesByName.get(genFilePath);
    if (genFile) {
      host.writeFile(emitPath, genFile.source !, false, onError, [sourceFile]);
    }
  }
}

function createWriteFileCallback(
    emitFlags: EmitFlags, host: ts.CompilerHost, metadataCache: LowerMetadataCache,
    generatedFiles: GeneratedFile[]) {
  const generatedFilesByName = new Map<string, GeneratedFile>();
  generatedFiles.forEach(f => generatedFilesByName.set(f.genFileUrl, f));
  return (fileName: string, data: string, writeByteOrderMark: boolean,
          onError?: (message: string) => void, sourceFiles?: ts.SourceFile[]) => {
    const sourceFile = sourceFiles && sourceFiles.length == 1 ? sourceFiles[0] : null;
    if (sourceFile) {
      const isGenerated = GENERATED_FILES.test(fileName);
      if (isGenerated) {
        writeNgSummaryJson(host, fileName, sourceFile, generatedFilesByName, onError);
      }
      if (!isGenerated && (emitFlags & EmitFlags.Metadata)) {
        writeMetadata(host, fileName, sourceFile, metadataCache, onError);
      }
      if (isGenerated) {
        const genFile = generatedFilesByName.get(sourceFile.fileName);
        if (!genFile || !genFile.stmts || !genFile.stmts.length) {
          // Don't emit empty generated files
          return;
        }
      }
    }
    host.writeFile(fileName, data, writeByteOrderMark, onError, sourceFiles);
  };
}

function getNgOptionDiagnostics(options: CompilerOptions): Diagnostic[] {
  if (options.annotationsAs) {
    switch (options.annotationsAs) {
      case 'decorators':
      case 'static fields':
        break;
      default:
        return [{
          messageText:
              'Angular compiler options "annotationsAs" only supports "static fields" and "decorators"',
          category: ts.DiagnosticCategory.Error,
          source: SOURCE,
          code: DEFAULT_ERROR_CODE
        }];
    }
  }
  return [];
}

function createProgramWithStubsHost(
    generatedFiles: GeneratedFile[], originalProgram: ts.Program,
    originalHost: ts.CompilerHost): ts.CompilerHost&TypeCheckHost {
  interface FileData {
    g: GeneratedFile;
    s?: ts.SourceFile;
    emitCtx?: EmitterVisitorContext;
  }
  return new class implements ts.CompilerHost, TypeCheckHost {
    private generatedFiles: Map<string, FileData>;
    private emitter = new TypeScriptEmitter();
    writeFile: ts.WriteFileCallback;
    getCancellationToken: () => ts.CancellationToken;
    getDefaultLibLocation: () => string;
    trace: (s: string) => void;
    getDirectories: (path: string) => string[];
    directoryExists: (directoryName: string) => boolean;
    constructor() {
      this.generatedFiles =
          new Map(generatedFiles.filter(g => g.source || (g.stmts && g.stmts.length))
                      .map<[string, FileData]>(g => [g.genFileUrl, {g}]));
      this.writeFile = originalHost.writeFile;
      if (originalHost.getDirectories) {
        this.getDirectories = path => originalHost.getDirectories !(path);
      }
      if (originalHost.directoryExists) {
        this.directoryExists = directoryName => originalHost.directoryExists !(directoryName);
      }
      if (originalHost.getCancellationToken) {
        this.getCancellationToken = () => originalHost.getCancellationToken !();
      }
      if (originalHost.getDefaultLibLocation) {
        this.getDefaultLibLocation = () => originalHost.getDefaultLibLocation !();
      }
      if (originalHost.trace) {
        this.trace = s => originalHost.trace !(s);
      }
    }
    ngSpanOf(fileName: string, line: number, character: number): ParseSourceSpan|null {
      const data = this.generatedFiles.get(fileName);
      if (data && data.emitCtx) {
        return data.emitCtx.spanOf(line, character);
      }
      return null;
    }
    getSourceFile(
        fileName: string, languageVersion: ts.ScriptTarget,
        onError?: ((message: string) => void)|undefined): ts.SourceFile {
      const data = this.generatedFiles.get(fileName);
      if (data) {
        if (!data.s) {
          const {sourceText, context} = this.emitter.emitStatementsAndContext(
              data.g.srcFileUrl, data.g.genFileUrl, data.g.stmts !,
              /* preamble */ undefined, /* emitSourceMaps */ undefined,
              /* referenceFilter */ undefined);
          data.emitCtx = context;
          data.s = ts.createSourceFile(fileName, sourceText, languageVersion);
        }
        return data.s;
      }
      return originalProgram.getSourceFile(fileName) ||
          originalHost.getSourceFile(fileName, languageVersion, onError);
    }
    readFile(fileName: string): string {
      const data = this.generatedFiles.get(fileName);
      if (data) {
        return data.g.source || toTypeScript(data.g);
      }
      return originalHost.readFile(fileName);
    }
    getDefaultLibFileName = (options: ts.CompilerOptions) =>
        originalHost.getDefaultLibFileName(options);
    getCurrentDirectory = () => originalHost.getCurrentDirectory();
    getCanonicalFileName = (fileName: string) => originalHost.getCanonicalFileName(fileName);
    useCaseSensitiveFileNames = () => originalHost.useCaseSensitiveFileNames();
    getNewLine = () => originalHost.getNewLine();
    realPath = (p: string) => p;
    fileExists = (fileName: string) =>
        this.generatedFiles.has(fileName) || originalHost.fileExists(fileName);
  };
}

export function i18nExtract(
    formatName: string | null, outFile: string | null, host: ts.CompilerHost,
    options: CompilerOptions, bundle: MessageBundle): string[] {
  formatName = formatName || 'null';
  // Checks the format and returns the extension
  const ext = i18nGetExtension(formatName);
  const content = i18nSerialize(bundle, formatName, options);
  const dstFile = outFile || `messages.${ext}`;
  const dstPath = path.resolve(options.outDir || options.basePath, dstFile);
  host.writeFile(dstPath, content, false);
  return [dstPath];
}

export function i18nSerialize(
    bundle: MessageBundle, formatName: string, options: CompilerOptions): string {
  const format = formatName.toLowerCase();
  let serializer: Serializer;

  switch (format) {
    case 'xmb':
      serializer = new Xmb();
      break;
    case 'xliff2':
    case 'xlf2':
      serializer = new Xliff2();
      break;
    case 'xlf':
    case 'xliff':
    default:
      serializer = new Xliff();
  }
  return bundle.write(
      serializer, (sourcePath: string) =>
                      options.basePath ? path.relative(options.basePath, sourcePath) : sourcePath);
}

export function i18nGetExtension(formatName: string): string {
  const format = (formatName || 'xlf').toLowerCase();

  switch (format) {
    case 'xmb':
      return 'xmb';
    case 'xlf':
    case 'xlif':
    case 'xliff':
    case 'xlf2':
    case 'xliff2':
      return 'xlf';
  }

  throw new Error(`Unsupported format "${formatName}"`);
}
