import type * as vscode from 'vscode-languageserver-protocol';
import type { ServiceContext, AutoInsertionContext } from '../types';
import { languageFeatureWorker } from '../utils/featureWorkers';
import { NoneCancellationToken } from '../utils/cancellation';
import { isAutoInsertEnabled } from '@volar/language-core';

export function register(context: ServiceContext) {

	return (uri: string, position: vscode.Position, autoInsertContext: AutoInsertionContext, token = NoneCancellationToken) => {

		return languageFeatureWorker(
			context,
			uri,
			() => ({ position, autoInsertContext }),
			function* (map) {
				for (const mappedPosition of map.toGeneratedPositions(position, isAutoInsertEnabled)) {

					const rangeOffset = map.map.getGeneratedOffset(autoInsertContext.lastChange.rangeOffset)?.[0];
					const range = map.toGeneratedRange(autoInsertContext.lastChange.range);

					if (rangeOffset !== undefined && range) {
						yield {
							position: mappedPosition,
							autoInsertContext: {
								lastChange: {
									...autoInsertContext.lastChange,
									rangeOffset,
									range,
								},
							},
						};
					}
				}
			},
			(service, document, arg) => {
				if (token.isCancellationRequested) {
					return;
				}
				return service.provideAutoInsertionEdit?.(document, arg.position, arg.autoInsertContext, token);
			},
			(item, map) => {
				if (!map || typeof item === 'string') {
					return item;
				}
				const range = map.toSourceRange(item.range, isAutoInsertEnabled);
				if (range) {
					item.range = range;
					return item;
				}
			},
		);
	};
}