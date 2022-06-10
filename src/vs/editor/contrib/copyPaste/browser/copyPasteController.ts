/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DataTransfers } from 'vs/base/browser/dnd';
import { addDisposableListener } from 'vs/base/browser/dom';
import { CancelablePromise, createCancelablePromise } from 'vs/base/common/async';
import { CancellationToken } from 'vs/base/common/cancellation';
import { createStringDataTransferItem, VSDataTransfer } from 'vs/base/common/dataTransfer';
import { Disposable } from 'vs/base/common/lifecycle';
import { Mimes } from 'vs/base/common/mime';
import { generateUuid } from 'vs/base/common/uuid';
import { toVSDataTransfer } from 'vs/editor/browser/dnd';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { IBulkEditService, ResourceEdit } from 'vs/editor/browser/services/bulkEditService';
import { Selection } from 'vs/editor/common/core/selection';
import { IEditorContribution } from 'vs/editor/common/editorCommon';
import { DocumentPasteEdit, DocumentPasteEditProvider } from 'vs/editor/common/languages';
import { ITextModel } from 'vs/editor/common/model';
import { ILanguageFeaturesService } from 'vs/editor/common/services/languageFeatures';
import { CodeEditorStateFlag, EditorStateCancellationTokenSource } from 'vs/editor/contrib/editorState/browser/editorState';
import { performSnippetEdit } from 'vs/editor/contrib/snippet/browser/snippetController2';
import { SnippetParser } from 'vs/editor/contrib/snippet/browser/snippetParser';
import { IClipboardService } from 'vs/platform/clipboard/common/clipboardService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';

const vscodeClipboardMime = 'application/vnd.code.copyId';

const defaultPasteEditProvider = new class implements DocumentPasteEditProvider {
	pasteMimeTypes = [Mimes.text, 'text'];

	async provideDocumentPasteEdits(model: ITextModel, selections: Selection[], dataTransfer: VSDataTransfer, _token: CancellationToken): Promise<DocumentPasteEdit | undefined> {
		const textDataTransfer = dataTransfer.get(Mimes.text) ?? dataTransfer.get('text');
		if (textDataTransfer) {
			const text = await textDataTransfer.asString();
			return {
				insertText: text
			};
		}

		return undefined;
	}
};

export class CopyPasteController extends Disposable implements IEditorContribution {

	public static readonly ID = 'editor.contrib.copyPasteActionController';

	public static get(editor: ICodeEditor): CopyPasteController {
		return editor.getContribution<CopyPasteController>(CopyPasteController.ID)!;
	}

	private readonly _editor: ICodeEditor;

	private _currentClipboardItem?: {
		readonly handle: string;
		readonly dataTransferPromise: CancelablePromise<VSDataTransfer>;
	};

	constructor(
		editor: ICodeEditor,
		@IBulkEditService private readonly _bulkEditService: IBulkEditService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
	) {
		super();

		this._editor = editor;

		const container = editor.getContainerDomNode();
		this._register(addDisposableListener(container, 'copy', e => this.handleCopy(e)));
		this._register(addDisposableListener(container, 'cut', e => this.handleCopy(e)));
		this._register(addDisposableListener(container, 'paste', e => this.handlePaste(e), true));
	}

	private arePasteActionsEnabled(model: ITextModel): boolean {
		return this._configurationService.getValue('editor.experimental.pasteActions.enabled', {
			resource: model.uri
		});
	}

	private handleCopy(e: ClipboardEvent) {
		if (!e.clipboardData) {
			return;
		}

		const model = this._editor.getModel();
		const selections = this._editor.getSelections();
		if (!model || !selections?.length) {
			return;
		}

		if (!this.arePasteActionsEnabled(model)) {
			return;
		}

		const providers = this._languageFeaturesService.documentPasteEditProvider.ordered(model).filter(x => !!x.prepareDocumentPaste);
		if (!providers.length) {
			return;
		}

		const dataTransfer = toVSDataTransfer(e.clipboardData);

		// Save off a handle pointing to data that VS Code maintains.
		const handle = generateUuid();
		e.clipboardData.setData(vscodeClipboardMime, handle);

		const promise = createCancelablePromise(async token => {
			const results = await Promise.all(providers.map(provider => {
				return provider.prepareDocumentPaste!(model, selections, dataTransfer, token);
			}));

			for (const result of results) {
				result?.forEach((value, key) => {
					dataTransfer.replace(key, value);
				});
			}

			return dataTransfer;
		});

		this._currentClipboardItem?.dataTransferPromise.cancel();
		this._currentClipboardItem = { handle: handle, dataTransferPromise: promise };
	}

	private async handlePaste(e: ClipboardEvent) {
		const selections = this._editor.getSelections();
		if (!e.clipboardData || !selections?.length || !this._editor.hasModel()) {
			return;
		}

		const model = this._editor.getModel();
		if (!this.arePasteActionsEnabled(model)) {
			return;
		}

		const handle = e.clipboardData?.getData(vscodeClipboardMime);
		if (typeof handle !== 'string') {
			return;
		}

		const providers = this._languageFeaturesService.documentPasteEditProvider.ordered(model);
		if (!providers.length) {
			return;
		}

		e.preventDefault();
		e.stopImmediatePropagation();

		const originalDocVersion = model.getVersionId();
		const tokenSource = new EditorStateCancellationTokenSource(this._editor, CodeEditorStateFlag.Value | CodeEditorStateFlag.Selection);

		try {
			const dataTransfer = toVSDataTransfer(e.clipboardData);

			if (handle && this._currentClipboardItem?.handle === handle) {
				const toMergeDataTransfer = await this._currentClipboardItem.dataTransferPromise;
				toMergeDataTransfer.forEach((value, key) => {
					dataTransfer.replace(key, value);
				});
			}

			if (!dataTransfer.has(Mimes.uriList)) {
				const resources = await this._clipboardService.readResources();
				if (resources.length) {
					const value = resources.join('\n');
					dataTransfer.append(Mimes.uriList, createStringDataTransferItem(value));
				}
			}

			dataTransfer.delete(vscodeClipboardMime);

			for (const provider of [...providers, defaultPasteEditProvider]) {
				if (!provider.pasteMimeTypes.some(type => {
					if (type.toLowerCase() === DataTransfers.FILES.toLowerCase()) {
						return [...dataTransfer.values()].some(item => item.asFile());
					}
					return dataTransfer.has(type);
				})) {
					continue;
				}

				const edit = await provider.provideDocumentPasteEdits(model, selections, dataTransfer, tokenSource.token);
				if (originalDocVersion !== model.getVersionId()) {
					return;
				}

				if (edit) {
					performSnippetEdit(this._editor, typeof edit.insertText === 'string' ? SnippetParser.escape(edit.insertText) : edit.insertText.snippet, selections);

					if (edit.additionalEdit) {
						await this._bulkEditService.apply(ResourceEdit.convert(edit.additionalEdit), { editor: this._editor });
					}
					return;
				}
			}
		} finally {
			tokenSource.dispose();
		}
	}
}
