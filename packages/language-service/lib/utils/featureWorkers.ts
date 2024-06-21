import type { CodeInformation, LinkedCodeMap, SourceMap, SourceScript, VirtualCode } from '@volar/language-core';
import type * as vscode from 'vscode-languageserver-protocol';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { URI } from 'vscode-uri';
import type { LanguageServiceContext, LanguageServicePlugin, LanguageServicePluginInstance } from '../types';

export type DocumentsAndMap = [
	sourceDocument: TextDocument,
	embeddedDocument: TextDocument,
	map: SourceMap<CodeInformation>,
];

export function documentFeatureWorker<T>(
	context: LanguageServiceContext,
	uri: URI,
	valid: (info: DocumentsAndMap) => boolean,
	worker: (plugin: [LanguageServicePlugin, LanguageServicePluginInstance], document: TextDocument) => Thenable<T | null | undefined> | T | null | undefined,
	transformResult: (result: T, map?: DocumentsAndMap) => T | undefined,
	combineResult?: (results: T[]) => T
) {
	return languageFeatureWorker(
		context,
		uri,
		() => void 0,
		function* (map) {
			if (valid(map)) {
				yield;
			}
		},
		worker,
		transformResult,
		combineResult
	);
}

export async function languageFeatureWorker<T, K>(
	context: LanguageServiceContext,
	uri: URI,
	getRealDocParams: () => K,
	eachVirtualDocParams: (map: DocumentsAndMap) => Generator<K>,
	worker: (plugin: [LanguageServicePlugin, LanguageServicePluginInstance], document: TextDocument, params: K, map?: DocumentsAndMap) => Thenable<T | null | undefined> | T | null | undefined,
	transformResult: (result: T, map?: DocumentsAndMap) => T | undefined,
	combineResult?: (results: T[]) => T
) {
	const sourceScript = context.language.scripts.get(uri);
	if (!sourceScript) {
		return;
	}

	let results: T[] = [];

	if (sourceScript.generated) {

		for (const docs of forEachEmbeddedDocument(context, sourceScript, sourceScript.generated.root)) {

			if (results.length && !combineResult) {
				continue;
			}

			for (const mappedArg of eachVirtualDocParams(docs)) {

				if (results.length && !combineResult) {
					continue;
				}

				for (const [pluginIndex, plugin] of Object.entries(context.plugins)) {
					if (context.disabledServicePlugins.has(plugin[1])) {
						continue;
					}

					if (results.length && !combineResult) {
						continue;
					}

					const rawResult = await safeCall(
						() => worker(plugin, docs[1], mappedArg, docs),
						`Language service plugin "${plugin[0].name}" (${pluginIndex}) failed to provide document feature for ${docs[1].uri}.`
					);
					if (!rawResult) {
						continue;
					}
					const mappedResult = transformResult(rawResult, docs);
					if (!mappedResult) {
						continue;
					}

					results.push(mappedResult);
				}
			}
		}
	}
	else {

		const document = context.documents.get(uri, sourceScript.languageId, sourceScript.snapshot);
		const params = getRealDocParams();

		for (const [pluginIndex, plugin] of Object.entries(context.plugins)) {
			if (context.disabledServicePlugins.has(plugin[1])) {
				continue;
			}

			const embeddedResult = await safeCall(
				() => worker(plugin, document, params, undefined),
				`Language service plugin "${plugin[0].name}" (${pluginIndex}) failed to provide document feature for ${document.uri}.`
			);
			if (!embeddedResult) {
				continue;
			}

			const result = transformResult(embeddedResult, undefined);
			if (!result) {
				continue;
			}

			results.push(result);

			if (!combineResult) {
				break;
			}
		}
	}

	if (combineResult && results.length > 0) {
		const combined = combineResult(results);
		return combined;
	}
	else if (results.length > 0) {
		return results[0];
	}
}

export async function safeCall<T>(cb: () => Thenable<T> | T, errorMsg?: string) {
	try {
		return await cb();
	}
	catch (err) {
		console.warn(errorMsg, err);
	}
}

export function* forEachEmbeddedDocument(
	context: LanguageServiceContext,
	sourceScript: SourceScript<URI>,
	current: VirtualCode
): Generator<DocumentsAndMap> {
	if (current.embeddedCodes) {
		for (const embeddedCode of current.embeddedCodes) {
			yield* forEachEmbeddedDocument(context, sourceScript, embeddedCode);
		}
	}
	const embeddedDocumentUri = context.encodeEmbeddedDocumentUri(sourceScript.id, current.id);
	if (!context.disabledEmbeddedDocumentUris.get(embeddedDocumentUri)) {
		yield [
			context.documents.get(sourceScript.id, current.languageId, current.snapshot),
			context.documents.get(embeddedDocumentUri, current.languageId, current.snapshot),
			context.language.maps.get(current, sourceScript),
		];
	}
}

export function getEmbeddedFilesByLevel(context: LanguageServiceContext, sourceFileUri: URI, rootFile: VirtualCode, level: number) {

	const embeddedFilesByLevel: VirtualCode[][] = [[rootFile]];

	while (true) {

		if (embeddedFilesByLevel.length > level) {
			return embeddedFilesByLevel[level];
		}

		const nextLevel: VirtualCode[] = [];

		for (const file of embeddedFilesByLevel[embeddedFilesByLevel.length - 1]) {
			if (file.embeddedCodes) {
				for (const embedded of file.embeddedCodes) {
					if (!context.disabledEmbeddedDocumentUris.get(context.encodeEmbeddedDocumentUri(sourceFileUri, embedded.id))) {
						nextLevel.push(embedded);
					}
				}
			}
		}

		embeddedFilesByLevel.push(nextLevel);
	}
}

export function getSourceRange(docs: DocumentsAndMap, range: vscode.Range, filter?: (data: CodeInformation) => boolean) {
	for (const result of getSourceRanges(docs, range, filter)) {
		return result;
	}
}

export function getGeneratedRange(docs: DocumentsAndMap, range: vscode.Range, filter?: (data: CodeInformation) => boolean) {
	for (const result of getGeneratedRanges(docs, range, filter)) {
		return result;
	}
}

export function* getSourceRanges([sourceDocument, embeddedDocument, map]: DocumentsAndMap, range: vscode.Range, filter?: (data: CodeInformation) => boolean) {
	for (const [mappedStart, mappedEnd] of map.getSourceStartEnd(
		embeddedDocument.offsetAt(range.start),
		embeddedDocument.offsetAt(range.end),
		true,
		filter
	)) {
		yield { start: sourceDocument.positionAt(mappedStart), end: sourceDocument.positionAt(mappedEnd) };
	}
}

export function* getGeneratedRanges([sourceDocument, embeddedDocument, map]: DocumentsAndMap, range: vscode.Range, filter?: (data: CodeInformation) => boolean) {
	for (const [mappedStart, mappedEnd] of map.getGeneratedStartEnd(
		sourceDocument.offsetAt(range.start),
		sourceDocument.offsetAt(range.end),
		true,
		filter
	)) {
		yield { start: embeddedDocument.positionAt(mappedStart), end: embeddedDocument.positionAt(mappedEnd) };
	}
}

export function* getSourcePositions([sourceDocument, embeddedDocument, map]: DocumentsAndMap, position: vscode.Position, filter: (data: CodeInformation) => boolean = () => true) {
	for (const mapped of map.getSourceOffsets(embeddedDocument.offsetAt(position), filter)) {
		yield sourceDocument.positionAt(mapped[0]);
	}
}

export function* getGeneratedPositions([sourceDocument, embeddedDocument, map]: DocumentsAndMap, position: vscode.Position, filter: (data: CodeInformation) => boolean = () => true) {
	for (const mapped of map.getGeneratedOffsets(sourceDocument.offsetAt(position), filter)) {
		yield embeddedDocument.positionAt(mapped[0]);
	}
}

export function* getLinkedCodePositions(document: TextDocument, linkedMap: LinkedCodeMap, posotion: vscode.Position) {
	for (const linkedPosition of linkedMap.getLinkedOffsets(document.offsetAt(posotion))) {
		yield document.positionAt(linkedPosition);
	}
}
