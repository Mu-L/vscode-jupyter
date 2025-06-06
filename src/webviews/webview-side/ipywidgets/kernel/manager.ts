// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import '@jupyter-widgets/controls/css/labvariables.css';
import type { Kernel, KernelMessage } from '@jupyterlab/services';
import type * as nbformat from '@jupyterlab/nbformat';
import { Widget } from '@lumino/widgets';
import fastDeepEqual from 'fast-deep-equal';
import { EventEmitter, Event } from '@c4312/evt';
import { logMessage, setLogger } from '../../react-common/logger';
import { IMessageHandler, PostOffice } from '../../react-common/postOffice';
import { create as createKernel } from './kernel';
import {
    IIPyWidgetManager,
    IJupyterLabWidgetManager,
    IJupyterLabWidgetManagerCtor,
    INotebookModel,
    ScriptLoader
} from './types';
import { KernelSocketOptions } from '../../../../kernels/types';
import { Deferred, createDeferred } from '../../../../platform/common/utils/async';
import { IInteractiveWindowMapping, IPyWidgetMessages, InteractiveWindowMessages } from '../../../../messageTypes';
import { WIDGET_MIMETYPE, WIDGET_STATE_MIMETYPE } from '../../../../platform/common/constants';
import { NotebookMetadata } from '../../../../platform/common/utils';
import { noop } from '../../../../platform/common/utils/misc';
import type { OutputItem, RendererContext } from 'vscode-notebook-renderer';
import { renderersAndMimetypes } from './mimeTypes';
import { base64ToUint8Array } from '../../../../platform/common/utils/string';

export class WidgetManager implements IIPyWidgetManager, IMessageHandler {
    public static get onDidChangeInstance(): Event<WidgetManager | undefined> {
        return WidgetManager._onDidChangeInstance.event;
    }
    private static _onDidChangeInstance = new EventEmitter<WidgetManager | undefined>();
    public static instance: WidgetManager | undefined;
    private manager?: IJupyterLabWidgetManager;
    private proxyKernel?: Kernel.IKernelConnection;
    private options?: KernelSocketOptions;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private pendingMessages: { message: string; payload: any }[] = [];
    /**
     * Contains promises related to model_ids that need to be displayed.
     * When we receive a message from the kernel of type = `display_data` for a widget (`application/vnd.jupyter.widget-view+json`),
     * then its time to display this.
     * We need to keep track of this. A boolean is sufficient, but we're using a promise so we can be notified when it is ready.
     *
     * @private
     * @memberof WidgetManager
     */
    private modelIdsToBeDisplayed = new Map<string, Deferred<void>>();
    private offlineModelIds = new Set<string>();
    constructor(
        private readonly widgetContainer: HTMLElement,
        private readonly postOffice: PostOffice,
        private readonly scriptLoader: ScriptLoader,
        private readonly JupyterLabWidgetManager: IJupyterLabWidgetManagerCtor,
        private readonly widgetState?: NotebookMetadata['widgets']
    ) {
        this.postOffice.addHandler(this);

        // Handshake.
        this.postOffice.sendMessage<IInteractiveWindowMapping>(IPyWidgetMessages.IPyWidgets_Ready);
        setLogger((category: 'error' | 'verbose', message: string) => {
            this.postOffice.sendMessage<IInteractiveWindowMapping>(IPyWidgetMessages.IPyWidgets_logMessage, {
                category,
                message
            });
            if (category === 'error') {
                console.error(message);
            }
        });
        if (widgetState) {
            this.initializeKernelAndWidgetManager(
                {
                    clientId: '',
                    id: '',
                    model: {
                        id: '',
                        name: ''
                    },
                    userName: '',
                    protocol: ''
                },
                widgetState
            );
        }
    }
    public dispose(): void {
        this.proxyKernel?.dispose(); // NOSONAR
        this.postOffice.removeHandler(this);
        this.clear().catch(noop);
    }
    public async clear(): Promise<void> {
        await this.manager?.clear_state();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public handleMessage(message: string, payload?: any) {
        if (message === IPyWidgetMessages.IPyWidgets_kernelOptions) {
            logMessage('Received IPyWidgetMessages.IPyWidgets_kernelOptions');
            this.initializeKernelAndWidgetManager(payload);
        } else if (message === IPyWidgetMessages.IPyWidgets_IsReadyRequest) {
            logMessage('Received IPyWidgetMessages.IPyWidgets_IsReadyRequest');
            this.postOffice.sendMessage<IInteractiveWindowMapping>(IPyWidgetMessages.IPyWidgets_Ready);
        } else if (message === IPyWidgetMessages.IPyWidgets_onRestartKernel) {
            logMessage('Received IPyWidgetMessages.IPyWidgets_onRestartKernel');
            // Kernel was restarted.
            this.manager?.dispose(); // NOSONAR
            this.manager = undefined;
            this.proxyKernel?.dispose(); // NOSONAR
            this.proxyKernel = undefined;
            WidgetManager.instance = undefined;
            WidgetManager._onDidChangeInstance.fire(undefined);
        } else if (!this.proxyKernel) {
            logMessage(`Received some pending message ${message}`);
            this.pendingMessages.push({ message, payload });
        }
        return true;
    }

    /**
     * Restore widgets from kernel and saved state.
     * (for now loading state from kernel is not supported).
     */
    public async restoreWidgets(
        notebook: INotebookModel,
        options?: {
            loadKernel: false;
            loadNotebook: boolean;
        }
    ): Promise<void> {
        if (!notebook) {
            return;
        }
        if (!options?.loadNotebook) {
            return;
        }
        if (!this.manager) {
            throw new Error('DS IPyWidgetManager not initialized.');
        }

        await this.manager.restoreWidgets(notebook, options);
        const state = notebook.metadata.get('widgets') as NotebookMetadata['widgets'];
        const widgetState = state && state[WIDGET_STATE_MIMETYPE] ? state[WIDGET_STATE_MIMETYPE] : undefined;
        if (widgetState) {
            const deferred = createDeferred<void>();
            deferred.resolve();
            Object.keys(widgetState.state).forEach((modelId) => {
                this.modelIdsToBeDisplayed.set(modelId, deferred);
                this.offlineModelIds.add(modelId);
            });
        }
    }

    /**
     * Renders a widget and returns a disposable (to remove the widget).
     *
     * @param {(nbformat.IMimeBundle & {model_id: string; version_major: number})} data
     * @param {HTMLElement} ele
     * @returns {Promise<{ dispose: Function }>}
     * @memberof WidgetManager
     */
    public async renderWidget(
        data: nbformat.IMimeBundle & { model_id: string; version_major: number },
        ele: HTMLElement
    ): Promise<Widget | undefined> {
        if (!data) {
            throw new Error(
                "application/vnd.jupyter.widget-view+json not in msg.content.data, as msg.content.data is 'undefined'."
            );
        }
        if (!this.manager) {
            throw new Error('DS IPyWidgetManager not initialized.');
        }

        if (!data || data.version_major !== 2) {
            console.warn('Widget data not available to render an ipywidget');
            return undefined;
        }

        const modelId = data.model_id as string;
        // Check if we have processed the data for this model.
        // If not wait.
        if (!this.modelIdsToBeDisplayed.has(modelId)) {
            this.modelIdsToBeDisplayed.set(modelId, createDeferred());
        }
        // Wait until it is flagged as ready to be processed.
        // This widget manager must have received this message and performed all operations before this.
        // Once all messages prior to this have been processed in sequence and this message is received,
        // then, and only then are we ready to render the widget.
        // I.e. this is a way of synchronizing the render with the processing of the messages.
        logMessage(`Waiting for model to be available before rendering it ${data.model_id}`);
        await this.modelIdsToBeDisplayed.get(modelId)!.promise;

        const modelPromise = this.manager.get_model(data.model_id);
        if (!modelPromise) {
            console.warn('Widget model not available to render an ipywidget');
            return undefined;
        }

        // IPyWidgets may not have completed creating the model.
        // ipywidgets have a promise, as the model may get created by a 3rd party library.
        // That 3rd party library may not be available and may have to be downloaded.
        // Hence the promise to wait until it has been created.
        const model = await modelPromise;
        if (this.widgetState && this.offlineModelIds.has(modelId)) {
            model.comm_live = false; // For widgets state in notebooks, there is no live kernel.
        }
        const view = await this.manager.create_view(model, { el: ele });
        // This code is only required when loading widgets from notebook,
        if (this.widgetState) {
            view.initialize({ model, el: ele, options: {} });
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return this.manager.display_view(data, view, { node: ele });
    }
    private initializeKernelAndWidgetManager(options: KernelSocketOptions, widgetState?: NotebookMetadata['widgets']) {
        if (this.manager && this.proxyKernel && fastDeepEqual(options, this.options)) {
            return;
        }
        this.options = options;
        this.proxyKernel?.dispose(); // NOSONAR
        this.proxyKernel = createKernel(options, this.postOffice, this.pendingMessages);
        this.pendingMessages = [];

        // Dispose any existing managers.
        this.manager?.dispose(); // NOSONAR
        try {
            // Create the real manager and point it at our proxy kernel.
            const manager = (this.manager = new this.JupyterLabWidgetManager(
                this.proxyKernel,
                this.widgetContainer,
                this.scriptLoader,
                logMessage,
                widgetState
            ));

            const registeredMimeTypes = new Set<string>();
            renderersAndMimetypes.forEach((mimeTypes, rendererId) => {
                mimeTypes.forEach((mime) => {
                    if (registeredMimeTypes.has(mime) || !manager.registerMimeRenderer) {
                        return;
                    }
                    registeredMimeTypes.add(mime);
                    manager.registerMimeRenderer(mime, async ({ data, metadata }, node) => {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const context = (globalThis as any).jupyter_vscode_rendererContext as RendererContext<any>;
                        const renderer = await context.getRenderer(rendererId);
                        const isImage = mime.toLowerCase().startsWith('image/') && !mime.toLowerCase().includes('svg');
                        const renderOutputItem = renderer?.renderOutputItem as
                            | undefined
                            | ((outputItem: OutputItem, element: HTMLElement, signal: AbortSignal) => void);
                        if (renderOutputItem) {
                            renderOutputItem(
                                {
                                    id: new Date().getTime().toString(), // Not used except when saving plots, but with nested outputs, thats not possible.
                                    metadata,
                                    text: () => {
                                        if (
                                            (mime.startsWith('text/') || mime.startsWith('image/svg+xml')) &&
                                            typeof data[mime] === 'string'
                                        ) {
                                            return data[mime] as string;
                                        }
                                        return JSON.stringify(data[mime]);
                                    },
                                    json: () => {
                                        return data[mime];
                                    },
                                    blob() {
                                        if (isImage) {
                                            const bytes = base64ToUint8Array(data[mime] as string);
                                            return new Blob([bytes], { type: mime });
                                        } else {
                                            throw new Error(`Not able to get blob for ${mime}.`);
                                        }
                                    },
                                    data() {
                                        if (isImage) {
                                            return base64ToUint8Array(data[mime] as string);
                                        } else {
                                            throw new Error(`Not able to get blob for ${mime}.`);
                                        }
                                    },
                                    mime
                                },
                                node,
                                new AbortController().signal
                            );
                        }
                    });
                });
            });

            // Listen for display data messages so we can prime the model for a display data
            this.proxyKernel.iopubMessage.connect(this.handleDisplayDataMessage.bind(this));

            // Listen for unhandled IO pub so we can forward to the extension
            this.manager.onUnhandledIOPubMessage.connect(this.handleUnhandledIOPubMessage.bind(this));

            // Tell the observable about our new manager
            WidgetManager.instance = this;
            WidgetManager._onDidChangeInstance.fire(this);
        } catch (ex) {
            // eslint-disable-next-line no-console
            console.error('Failed to initialize WidgetManager', ex);
        }
    }
    /**
     * Ensure we create the model for the display data.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async handleDisplayDataMessage(_sender: any, payload: KernelMessage.IIOPubMessage) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const jupyterLab = require('@jupyterlab/services') as typeof import('@jupyterlab/services'); // NOSONAR

        if (
            !jupyterLab.KernelMessage.isDisplayDataMsg(payload) &&
            !jupyterLab.KernelMessage.isExecuteResultMsg(payload)
        ) {
            return;
        }
        const displayMsg = payload as KernelMessage.IDisplayDataMsg | KernelMessage.IExecuteResultMsg;

        if (displayMsg.content && displayMsg.content.data && displayMsg.content.data[WIDGET_MIMETYPE]) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const data = displayMsg.content.data[WIDGET_MIMETYPE] as any;
            const modelId = data.model_id;
            logMessage(`Received display data message ${modelId}`);
            let deferred = this.modelIdsToBeDisplayed.get(modelId);
            if (!deferred) {
                deferred = createDeferred();
                this.modelIdsToBeDisplayed.set(modelId, deferred);
            }
            if (!this.manager) {
                throw new Error('DS IPyWidgetManager not initialized');
            }
            const modelPromise = this.manager.get_model(data.model_id);
            if (modelPromise) {
                try {
                    const m = await modelPromise;
                    console.log(m);
                    deferred.resolve();
                } catch (ex) {
                    deferred.reject(ex);
                }
            } else {
                deferred.resolve();
            }
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private handleUnhandledIOPubMessage(_manager: any, msg: KernelMessage.IIOPubMessage) {
        // Send this to the other side
        this.postOffice.sendMessage<IInteractiveWindowMapping>(
            InteractiveWindowMessages.IPyWidgetUnhandledKernelMessage,
            msg
        );
    }
}
