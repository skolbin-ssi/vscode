/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { Registry } from 'vs/platform/registry/common/platform';
import { Action2, registerAction2 } from 'vs/platform/actions/common/actions';
import { ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { IQuickInputButton, IQuickInputService, IQuickPickItem } from 'vs/platform/quickinput/common/quickInput';
import { NOTEBOOK_ACTIONS_CATEGORY } from 'vs/workbench/contrib/notebook/browser/contrib/coreActions';
import { getNotebookEditorFromEditorPane, INotebookEditor, NOTEBOOK_IS_ACTIVE_EDITOR } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { Extensions as WorkbenchExtensions, IWorkbenchContributionsRegistry, IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { LifecyclePhase } from 'vs/workbench/services/lifecycle/common/lifecycle';
import { combinedDisposable, Disposable, DisposableStore, MutableDisposable } from 'vs/base/common/lifecycle';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from 'vs/workbench/services/statusbar/common/statusbar';
import { configureKernelIcon, selectKernelIcon } from 'vs/workbench/contrib/notebook/browser/notebookIcons';
import { ThemeIcon } from 'vs/platform/theme/common/themeService';
import { NotebookViewModel } from 'vs/workbench/contrib/notebook/browser/viewModel/notebookViewModel';
import { ExtensionIdentifier } from 'vs/platform/extensions/common/extensions';
import { INotebookKernelService } from 'vs/workbench/contrib/notebook/common/notebookKernelService';
import { INotebookKernel, INotebookTextModel } from 'vs/workbench/contrib/notebook/common/notebookCommon';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'notebook.selectKernel',
			category: NOTEBOOK_ACTIONS_CATEGORY,
			title: { value: nls.localize('notebookActions.selectKernel', "Select Notebook Controller"), original: 'Select Notebook Controller' },
			precondition: NOTEBOOK_IS_ACTIVE_EDITOR,
			icon: selectKernelIcon,
			f1: true,
			description: {
				description: nls.localize('notebookActions.selectKernel.args', "Notebook Kernel Args"),
				args: [
					{
						name: 'kernelInfo',
						description: 'The kernel info',
						schema: {
							'type': 'object',
							'required': ['id', 'extension'],
							'properties': {
								'id': {
									'type': 'string'
								},
								'extension': {
									'type': 'string'
								}
							}
						}
					}
				]
			},

		});
	}

	async run(accessor: ServicesAccessor, context?: { id: string, extension: string }): Promise<void> {
		const notebookKernelService = accessor.get(INotebookKernelService);
		const editorService = accessor.get(IEditorService);
		const quickInputService = accessor.get(IQuickInputService);

		const editor = getNotebookEditorFromEditorPane(editorService.activeEditorPane);
		if (!editor || !editor.hasModel()) {
			return;
		}

		if (context && (typeof context.id !== 'string' || typeof context.extension !== 'string')) {
			// validate context: id & extension MUST be strings
			context = undefined;
		}

		const notebook = editor.viewModel.notebookDocument;
		const { bound, all } = notebookKernelService.getNotebookKernels(notebook);

		if (bound && context && bound.id === context.id && ExtensionIdentifier.equals(bound.extension, context.extension)) {
			// current kernel is wanted kernel -> done
			return;
		}

		let newKernel: INotebookKernel | undefined;
		if (context) {
			for (let candidate of all) {
				if (candidate.id === context.id && ExtensionIdentifier.equals(candidate.extension, context.extension)) {
					newKernel = candidate;
					break;
				}
			}
		}

		if (!newKernel) {
			type KernelPick = IQuickPickItem & { kernel: INotebookKernel };
			const configButton: IQuickInputButton = {
				iconClass: ThemeIcon.asClassName(configureKernelIcon),
				tooltip: nls.localize('notebook.promptKernel.setDefaultTooltip', "Set as default for '{0}' notebooks", editor.viewModel.viewType)
			};
			const picks = all.map(kernel => {
				const res = <KernelPick>{
					kernel,
					picked: kernel.id === bound?.id,
					label: kernel.label,
					description: kernel.description,
					detail: kernel.detail,
					buttons: [configButton]
				};
				if (kernel.id === bound?.id) {
					if (!res.description) {
						res.description = nls.localize('current1', "Currently Selected");
					} else {
						res.description = nls.localize('current2', "{0} - Currently Selected", res.description);
					}
				}
				{ return res; }
			});
			const pick = await quickInputService.pick(picks, {
				onDidTriggerItemButton: (context) => {
					notebookKernelService.updateNotebookTypeKernelBinding(notebook.viewType, context.item.kernel);
				}
			});

			if (pick) {
				newKernel = pick.kernel;
			}
		}

		if (newKernel) {
			notebookKernelService.updateNotebookInstanceKernelBinding(notebook, newKernel);
		}
	}
});

export class KernelStatus extends Disposable implements IWorkbenchContribution {

	private readonly _editorDisposables = this._register(new DisposableStore());
	private readonly _kernelInfoElement = this._register(new MutableDisposable());

	constructor(
		@IEditorService private readonly _editorService: IEditorService,
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@INotebookKernelService private readonly _notebookKernelService: INotebookKernelService,
	) {
		super();
		this._register(this._editorService.onDidActiveEditorChange(() => this._updateStatusbar()));
	}

	private _updateStatusbar() {
		this._editorDisposables.clear();

		const activeEditor = getNotebookEditorFromEditorPane(this._editorService.activeEditorPane);
		if (!activeEditor) {
			// not a notebook -> clean-up, done
			this._kernelInfoElement.clear();
			return;
		}

		const updateStatus = () => {
			const notebook = activeEditor.viewModel?.notebookDocument;
			if (notebook) {
				this._showKernelStatus(notebook);
			} else {
				this._kernelInfoElement.clear();
			}
		};

		this._editorDisposables.add(this._notebookKernelService.onDidAddKernel(updateStatus));
		this._editorDisposables.add(this._notebookKernelService.onDidChangeNotebookKernelBinding(updateStatus));
		this._editorDisposables.add(this._notebookKernelService.onDidChangeNotebookAffinity(updateStatus));
		this._editorDisposables.add(activeEditor.onDidChangeModel(updateStatus));
		updateStatus();
	}

	private _showKernelStatus(notebook: INotebookTextModel) {

		let { bound, all } = this._notebookKernelService.getNotebookKernels(notebook);
		let isSuggested = false;

		if (all.length === 0) {
			this._kernelInfoElement.clear();
			return;
		}

		if (!bound) {
			bound = all[0];
			isSuggested = true;
		}

		const text = `$(notebook-kernel-select) ${bound.label}`;
		const tooltip = bound.description ?? bound.detail ?? bound.label;
		const registration = this._statusbarService.addEntry(
			{
				text,
				ariaLabel: bound.label,
				tooltip: isSuggested ? nls.localize('tooltop', "{0} (suggestion)", tooltip) : tooltip,
				command: all.length > 1 ? 'notebook.selectKernel' : undefined,
			},
			'notebook.selectKernel',
			nls.localize('notebook.info', "Notebook Controller Info"),
			StatusbarAlignment.RIGHT,
			100
		);
		const listener = bound.onDidChange(() => this._showKernelStatus(notebook));
		this._kernelInfoElement.value = combinedDisposable(listener, registration);
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(KernelStatus, LifecyclePhase.Ready);

export class ActiveCellStatus extends Disposable implements IWorkbenchContribution {

	private readonly _itemDisposables = this._register(new DisposableStore());
	private readonly _accessor = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IEditorService private readonly _editorService: IEditorService,
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
	) {
		super();
		this._register(this._editorService.onDidActiveEditorChange(() => this._update()));
	}

	private _update() {
		this._itemDisposables.clear();
		const activeEditor = getNotebookEditorFromEditorPane(this._editorService.activeEditorPane);
		if (activeEditor) {
			this._itemDisposables.add(activeEditor.onDidChangeSelection(() => this._show(activeEditor)));
			this._show(activeEditor);
		} else {
			this._accessor.clear();
		}
	}

	private _show(editor: INotebookEditor) {
		const vm = editor.viewModel;
		if (!vm) {
			this._accessor.clear();
			return;
		}

		const newText = this._getSelectionsText(editor, vm);
		if (!newText) {
			this._accessor.clear();
			return;
		}

		const entry = { text: newText, ariaLabel: newText };
		if (!this._accessor.value) {
			this._accessor.value = this._statusbarService.addEntry(
				entry,
				'notebook.activeCellStatus',
				nls.localize('notebook.activeCellStatusName', "Notebook Editor Selections"),
				StatusbarAlignment.RIGHT,
				100);
		} else {
			this._accessor.value.update(entry);
		}
	}

	private _getSelectionsText(editor: INotebookEditor, vm: NotebookViewModel): string | undefined {
		const activeCell = editor.getActiveCell();
		if (!activeCell) {
			return undefined;
		}

		const idxFocused = vm.getCellIndex(activeCell) + 1;
		const numSelected = vm.getSelections().reduce((prev, range) => prev + (range.end - range.start), 0);
		return numSelected > 1 ?
			nls.localize('notebook.multiActiveCellIndicator', "Cell {0} ({1} selected)", idxFocused, numSelected) :
			nls.localize('notebook.singleActiveCellIndicator', "Cell {0}", idxFocused);
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(ActiveCellStatus, LifecyclePhase.Ready);
