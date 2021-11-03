/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ITheme, RendererType, Terminal as RawXtermTerminal } from 'xterm';
import type { ISearchOptions, SearchAddon as SearchAddonType } from 'xterm-addon-search';
import type { Unicode11Addon as Unicode11AddonType } from 'xterm-addon-unicode11';
import type { WebglAddon as WebglAddonType } from 'xterm-addon-webgl';
import { IXtermCore } from 'vs/workbench/contrib/terminal/browser/xterm-private';
import { ConfigurationTarget, IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { TerminalConfigHelper } from 'vs/workbench/contrib/terminal/browser/terminalConfigHelper';
import { DisposableStore } from 'vs/base/common/lifecycle';
import { IEditorOptions } from 'vs/editor/common/config/editorOptions';
import { TerminalLocation, TerminalSettingId } from 'vs/platform/terminal/common/terminal';
import { IColorTheme, IThemeService } from 'vs/platform/theme/common/themeService';
import { IViewDescriptorService, ViewContainerLocation } from 'vs/workbench/common/views';
import { editorBackground } from 'vs/platform/theme/common/colorRegistry';
import { ansiColorIdentifiers, TERMINAL_BACKGROUND_COLOR, TERMINAL_CURSOR_BACKGROUND_COLOR, TERMINAL_CURSOR_FOREGROUND_COLOR, TERMINAL_FOREGROUND_COLOR, TERMINAL_SELECTION_BACKGROUND_COLOR } from 'vs/workbench/contrib/terminal/common/terminalColorRegistry';
import { ICommandTracker, ITerminalFont, TERMINAL_VIEW_ID } from 'vs/workbench/contrib/terminal/common/terminal';
import { PANEL_BACKGROUND, SIDE_BAR_BACKGROUND } from 'vs/workbench/common/theme';
import { Color } from 'vs/base/common/color';
import { isSafari } from 'vs/base/browser/browser';
import { IXtermTerminal } from 'vs/workbench/contrib/terminal/browser/terminal';
import { ILogService } from 'vs/platform/log/common/log';
import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { TerminalStorageKeys } from 'vs/workbench/contrib/terminal/common/terminalStorageKeys';
import { INotificationService, IPromptChoice, Severity } from 'vs/platform/notification/common/notification';
import { CommandTrackerAddon } from 'vs/workbench/contrib/terminal/browser/xterm/commandTrackerAddon';
import { localize } from 'vs/nls';

// How long in milliseconds should an average frame take to render for a notification to appear
// which suggests the fallback DOM-based renderer
const SLOW_CANVAS_RENDER_THRESHOLD = 50;
const NUMBER_OF_FRAMES_TO_MEASURE = 20;

let SearchAddon: typeof SearchAddonType;
let Unicode11Addon: typeof Unicode11AddonType;
let WebglAddon: typeof WebglAddonType;

/**
 * Wraps the xterm object with additional functionality. Interaction with the backing process is out
 * of the scope of this class.
 */
export class XtermTerminal extends DisposableStore implements IXtermTerminal {
	/** The raw xterm.js instance */
	readonly raw: RawXtermTerminal;
	target?: TerminalLocation;

	private _core: IXtermCore;
	private static _suggestedRendererType: 'canvas' | 'dom' | undefined = undefined;
	private _container?: HTMLElement;

	// Always on addons
	private _commandTrackerAddon: CommandTrackerAddon;

	// Lazily loaded addons
	private _searchAddon?: SearchAddonType;

	// Optional addons
	private _unicode11Addon?: Unicode11AddonType;
	private _webglAddon?: WebglAddonType;

	get commandTracker(): ICommandTracker { return this._commandTrackerAddon; }

	/**
	 * @param xtermCtor The xterm.js constructor, this is passed in so it can be fetched lazily
	 * outside of this class such that {@link raw} is not nullable.
	 */
	constructor(
		xtermCtor: typeof RawXtermTerminal,
		private readonly _configHelper: TerminalConfigHelper,
		cols: number,
		rows: number,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IStorageService private readonly _storageService: IStorageService,
		@IThemeService private readonly _themeService: IThemeService,
		@IViewDescriptorService private readonly _viewDescriptorService: IViewDescriptorService
	) {
		super();

		const font = this._configHelper.getFont(undefined, true);
		const config = this._configHelper.config;
		const editorOptions = this._configurationService.getValue<IEditorOptions>('editor');

		this.raw = this.add(new xtermCtor({
			cols,
			rows,
			altClickMovesCursor: config.altClickMovesCursor && editorOptions.multiCursorModifier === 'alt',
			scrollback: config.scrollback,
			theme: this._getXtermTheme(),
			drawBoldTextInBrightColors: config.drawBoldTextInBrightColors,
			fontFamily: font.fontFamily,
			fontWeight: config.fontWeight,
			fontWeightBold: config.fontWeightBold,
			fontSize: font.fontSize,
			letterSpacing: font.letterSpacing,
			lineHeight: font.lineHeight,
			minimumContrastRatio: config.minimumContrastRatio,
			cursorBlink: config.cursorBlinking,
			cursorStyle: config.cursorStyle === 'line' ? 'bar' : config.cursorStyle,
			cursorWidth: config.cursorWidth,
			bellStyle: 'none',
			macOptionIsMeta: config.macOptionIsMeta,
			macOptionClickForcesSelection: config.macOptionClickForcesSelection,
			rightClickSelectsWord: config.rightClickBehavior === 'selectWord',
			fastScrollModifier: 'alt',
			fastScrollSensitivity: editorOptions.fastScrollSensitivity,
			scrollSensitivity: editorOptions.mouseWheelScrollSensitivity,
			rendererType: this._getBuiltInXtermRenderer(config.gpuAcceleration, XtermTerminal._suggestedRendererType),
			wordSeparator: config.wordSeparators
		}));
		this._core = (this.raw as any)._core as IXtermCore;

		this.add(this._configurationService.onDidChangeConfiguration(async e => {
			if (e.affectsConfiguration(TerminalSettingId.GpuAcceleration)) {
				XtermTerminal._suggestedRendererType = undefined;
			}
			if (e.affectsConfiguration('terminal.integrated') || e.affectsConfiguration('editor.fastScrollSensitivity') || e.affectsConfiguration('editor.mouseWheelScrollSensitivity') || e.affectsConfiguration('editor.multiCursorModifier')) {
				this.updateConfig();
			}
			if (e.affectsConfiguration(TerminalSettingId.UnicodeVersion)) {
				this._updateUnicodeVersion();
			}
		}));
		this.add(this._themeService.onDidColorThemeChange(theme => this._updateTheme(theme)));
		this.add(this._viewDescriptorService.onDidChangeLocation(({ views }) => {
			if (views.some(v => v.id === TERMINAL_VIEW_ID)) {
				this._updateTheme();
			}
		}));

		// Load addons

		this._updateUnicodeVersion();

		this._commandTrackerAddon = new CommandTrackerAddon();
		this.raw.loadAddon(this._commandTrackerAddon);

		this._getSearchAddonConstructor().then(addonCtor => {
			this._searchAddon = new addonCtor();
			this.raw.loadAddon(this._searchAddon);
		});
	}

	attachToElement(container: HTMLElement) {
		// Update the theme when attaching as the terminal location could have changed
		this._updateTheme();

		if (!this._container) {
			this.raw.open(container);
		}
		this._container = container;
	}

	updateConfig(): void {
		const config = this._configHelper.config;
		this._safeSetOption('altClickMovesCursor', config.altClickMovesCursor);
		this._setCursorBlink(config.cursorBlinking);
		this._setCursorStyle(config.cursorStyle);
		this._setCursorWidth(config.cursorWidth);
		this._safeSetOption('scrollback', config.scrollback);
		this._safeSetOption('drawBoldTextInBrightColors', config.drawBoldTextInBrightColors);
		this._safeSetOption('minimumContrastRatio', config.minimumContrastRatio);
		this._safeSetOption('fastScrollSensitivity', config.fastScrollSensitivity);
		this._safeSetOption('scrollSensitivity', config.mouseWheelScrollSensitivity);
		this._safeSetOption('macOptionIsMeta', config.macOptionIsMeta);
		const editorOptions = this._configurationService.getValue<IEditorOptions>('editor');
		this._safeSetOption('altClickMovesCursor', config.altClickMovesCursor && editorOptions.multiCursorModifier === 'alt');
		this._safeSetOption('macOptionClickForcesSelection', config.macOptionClickForcesSelection);
		this._safeSetOption('rightClickSelectsWord', config.rightClickBehavior === 'selectWord');
		this._safeSetOption('wordSeparator', config.wordSeparators);
		this._safeSetOption('customGlyphs', config.customGlyphs);
		if ((!isSafari && config.gpuAcceleration === 'auto' && XtermTerminal._suggestedRendererType === undefined) || config.gpuAcceleration === 'on') {
			this._enableWebglRenderer();
		} else {
			this._disposeOfWebglRenderer();
			this._safeSetOption('rendererType', this._getBuiltInXtermRenderer(config.gpuAcceleration, XtermTerminal._suggestedRendererType));
		}
	}

	forceRedraw() {
		this._webglAddon?.clearTextureAtlas();
		this.raw.clearTextureAtlas();
	}


	forceRefresh() {
		this._core.viewport?._innerRefresh();
	}

	forceUnpause() {
		// HACK: Force the renderer to unpause by simulating an IntersectionObserver event.
		// This is to fix an issue where dragging the windpow to the top of the screen to
		// maximize on Windows/Linux would fire an event saying that the terminal was not
		// visible.
		if (this.raw.getOption('rendererType') === 'canvas') {
			this._core._renderService?._onIntersectionChange({ intersectionRatio: 1 });
			// HACK: Force a refresh of the screen to ensure links are refresh corrected.
			// This can probably be removed when the above hack is fixed in Chromium.
			this.raw.refresh(0, this.raw.rows - 1);
		}
	}

	findNext(term: string, searchOptions: ISearchOptions): boolean {
		if (!this._searchAddon) {
			return false;
		}
		return this._searchAddon.findNext(term, searchOptions);
	}

	findPrevious(term: string, searchOptions: ISearchOptions): boolean {
		if (!this._searchAddon) {
			return false;
		}
		return this._searchAddon.findPrevious(term, searchOptions);
	}

	getFont(): ITerminalFont {
		return this._configHelper.getFont(this._core);
	}

	scrollDownLine(): void {
		this.raw.scrollLines(1);
	}

	scrollDownPage(): void {
		this.raw.scrollPages(1);
	}

	scrollToBottom(): void {
		this.raw.scrollToBottom();
	}

	scrollUpLine(): void {
		this.raw.scrollLines(-1);
	}

	scrollUpPage(): void {
		this.raw.scrollPages(-1);
	}

	scrollToTop(): void {
		this.raw.scrollToTop();
	}

	clearBuffer(): void {
		this.raw.clear();
	}

	private _safeSetOption(key: string, value: any): void {
		if (this.raw.getOption(key) !== value) {
			this.raw.setOption(key, value);
		}
	}

	private _setCursorBlink(blink: boolean): void {
		if (this.raw.getOption('cursorBlink') !== blink) {
			this.raw.setOption('cursorBlink', blink);
			this.raw.refresh(0, this.raw.rows - 1);
		}
	}

	private _setCursorStyle(style: string): void {
		if (this.raw.getOption('cursorStyle') !== style) {
			// 'line' is used instead of bar in VS Code to be consistent with editor.cursorStyle
			const xtermOption = style === 'line' ? 'bar' : style;
			this.raw.setOption('cursorStyle', xtermOption);
		}
	}

	private _setCursorWidth(width: number): void {
		if (this.raw.getOption('cursorWidth') !== width) {
			this.raw.setOption('cursorWidth', width);
		}
	}

	private _getBuiltInXtermRenderer(gpuAcceleration: string, suggestedRendererType?: string): RendererType {
		let rendererType: RendererType = 'canvas';
		if (gpuAcceleration === 'off' || (gpuAcceleration === 'auto' && suggestedRendererType === 'dom')) {
			rendererType = 'dom';
		}
		return rendererType;
	}

	private async _enableWebglRenderer(): Promise<void> {
		if (!this.raw.element || this._webglAddon) {
			return;
		}
		const Addon = await this._getWebglAddonConstructor();
		this._webglAddon = new Addon();
		try {
			this.raw.loadAddon(this._webglAddon);
			this._webglAddon.onContextLoss(() => {
				this._logService.info(`Webgl lost context, disposing of webgl renderer`);
				this._disposeOfWebglRenderer();
				this._safeSetOption('rendererType', 'dom');
			});
		} catch (e) {
			this._logService.warn(`Webgl could not be loaded. Falling back to the canvas renderer type.`, e);
			const neverMeasureRenderTime = this._storageService.getBoolean(TerminalStorageKeys.NeverMeasureRenderTime, StorageScope.GLOBAL, false);
			// if it's already set to dom, no need to measure render time
			if (!neverMeasureRenderTime && this._configHelper.config.gpuAcceleration !== 'off') {
				this._measureRenderTime();
			}
			this._safeSetOption('rendererType', 'canvas');
			XtermTerminal._suggestedRendererType = 'canvas';
			this._disposeOfWebglRenderer();
		}
	}

	protected async _getSearchAddonConstructor(): Promise<typeof SearchAddonType> {
		if (!SearchAddon) {
			SearchAddon = (await import('xterm-addon-search')).SearchAddon;
		}
		return SearchAddon;
	}

	protected async _getUnicode11Constructor(): Promise<typeof Unicode11AddonType> {
		if (!Unicode11Addon) {
			Unicode11Addon = (await import('xterm-addon-unicode11')).Unicode11Addon;
		}
		return Unicode11Addon;
	}

	protected async _getWebglAddonConstructor(): Promise<typeof WebglAddonType> {
		if (!WebglAddon) {
			WebglAddon = (await import('xterm-addon-webgl')).WebglAddon;
		}
		return WebglAddon;
	}

	private _disposeOfWebglRenderer(): void {
		try {
			this._webglAddon?.dispose();
		} catch {
			// ignore
		}
		this._webglAddon = undefined;
	}

	private async _measureRenderTime(): Promise<void> {
		const frameTimes: number[] = [];
		if (!this._core._renderService?._renderer._renderLayers) {
			return;
		}
		const textRenderLayer = this._core._renderService._renderer._renderLayers[0];
		const originalOnGridChanged = textRenderLayer?.onGridChanged;
		const evaluateCanvasRenderer = () => {
			// Discard first frame time as it's normal to take longer
			frameTimes.shift();

			const medianTime = frameTimes.sort((a, b) => a - b)[Math.floor(frameTimes.length / 2)];
			if (medianTime > SLOW_CANVAS_RENDER_THRESHOLD) {
				if (this._configHelper.config.gpuAcceleration === 'auto') {
					XtermTerminal._suggestedRendererType = 'dom';
					this.updateConfig();
				} else {
					const promptChoices: IPromptChoice[] = [
						{
							label: localize('yes', "Yes"),
							run: () => this._configurationService.updateValue(TerminalSettingId.GpuAcceleration, 'off', ConfigurationTarget.USER)
						} as IPromptChoice,
						{
							label: localize('no', "No"),
							run: () => { }
						} as IPromptChoice,
						{
							label: localize('dontShowAgain', "Don't Show Again"),
							isSecondary: true,
							run: () => this._storageService.store(TerminalStorageKeys.NeverMeasureRenderTime, true, StorageScope.GLOBAL, StorageTarget.MACHINE)
						} as IPromptChoice
					];
					this._notificationService.prompt(
						Severity.Warning,
						localize('terminal.slowRendering', 'Terminal GPU acceleration appears to be slow on your computer. Would you like to switch to disable it which may improve performance? [Read more about terminal settings](https://code.visualstudio.com/docs/editor/integrated-terminal#_changing-how-the-terminal-is-rendered).'),
						promptChoices
					);
				}
			}
		};

		textRenderLayer.onGridChanged = (terminal: RawXtermTerminal, firstRow: number, lastRow: number) => {
			const startTime = performance.now();
			originalOnGridChanged.call(textRenderLayer, terminal, firstRow, lastRow);
			frameTimes.push(performance.now() - startTime);
			if (frameTimes.length === NUMBER_OF_FRAMES_TO_MEASURE) {
				evaluateCanvasRenderer();
				// Restore original function
				textRenderLayer.onGridChanged = originalOnGridChanged;
			}
		};
	}

	private _getXtermTheme(theme?: IColorTheme): ITheme {
		if (!theme) {
			theme = this._themeService.getColorTheme();
		}

		const location = this._viewDescriptorService.getViewLocationById(TERMINAL_VIEW_ID)!;
		const foregroundColor = theme.getColor(TERMINAL_FOREGROUND_COLOR);
		let backgroundColor: Color | undefined;
		if (this.target === TerminalLocation.Editor) {
			backgroundColor = theme.getColor(TERMINAL_BACKGROUND_COLOR) || theme.getColor(editorBackground);
		} else {
			backgroundColor = theme.getColor(TERMINAL_BACKGROUND_COLOR) || (location === ViewContainerLocation.Panel ? theme.getColor(PANEL_BACKGROUND) : theme.getColor(SIDE_BAR_BACKGROUND));
		}
		const cursorColor = theme.getColor(TERMINAL_CURSOR_FOREGROUND_COLOR) || foregroundColor;
		const cursorAccentColor = theme.getColor(TERMINAL_CURSOR_BACKGROUND_COLOR) || backgroundColor;
		const selectionColor = theme.getColor(TERMINAL_SELECTION_BACKGROUND_COLOR);

		return {
			background: backgroundColor ? backgroundColor.toString() : undefined,
			foreground: foregroundColor ? foregroundColor.toString() : undefined,
			cursor: cursorColor ? cursorColor.toString() : undefined,
			cursorAccent: cursorAccentColor ? cursorAccentColor.toString() : undefined,
			selection: selectionColor ? selectionColor.toString() : undefined,
			black: theme.getColor(ansiColorIdentifiers[0])?.toString(),
			red: theme.getColor(ansiColorIdentifiers[1])?.toString(),
			green: theme.getColor(ansiColorIdentifiers[2])?.toString(),
			yellow: theme.getColor(ansiColorIdentifiers[3])?.toString(),
			blue: theme.getColor(ansiColorIdentifiers[4])?.toString(),
			magenta: theme.getColor(ansiColorIdentifiers[5])?.toString(),
			cyan: theme.getColor(ansiColorIdentifiers[6])?.toString(),
			white: theme.getColor(ansiColorIdentifiers[7])?.toString(),
			brightBlack: theme.getColor(ansiColorIdentifiers[8])?.toString(),
			brightRed: theme.getColor(ansiColorIdentifiers[9])?.toString(),
			brightGreen: theme.getColor(ansiColorIdentifiers[10])?.toString(),
			brightYellow: theme.getColor(ansiColorIdentifiers[11])?.toString(),
			brightBlue: theme.getColor(ansiColorIdentifiers[12])?.toString(),
			brightMagenta: theme.getColor(ansiColorIdentifiers[13])?.toString(),
			brightCyan: theme.getColor(ansiColorIdentifiers[14])?.toString(),
			brightWhite: theme.getColor(ansiColorIdentifiers[15])?.toString()
		};
	}

	private _updateTheme(theme?: IColorTheme): void {
		this.raw.setOption('theme', this._getXtermTheme(theme));
	}

	private async _updateUnicodeVersion(): Promise<void> {
		if (!this._unicode11Addon && this._configHelper.config.unicodeVersion === '11') {
			const Addon = await this._getUnicode11Constructor();
			this._unicode11Addon = new Addon();
			this.raw.loadAddon(this._unicode11Addon);
		}
		if (this.raw.unicode.activeVersion !== this._configHelper.config.unicodeVersion) {
			this.raw.unicode.activeVersion = this._configHelper.config.unicodeVersion;
		}
	}
}
