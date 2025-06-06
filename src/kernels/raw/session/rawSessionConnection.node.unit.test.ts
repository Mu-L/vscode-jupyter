// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ISignal, Signal } from '@lumino/signaling';
import * as sinon from 'sinon';
import { Kernel, KernelMessage, ServerConnection } from '@jupyterlab/services';
import { mock, when, instance, verify, anything } from 'ts-mockito';
import {
    CancellationError,
    CancellationTokenSource,
    Disposable,
    EventEmitter,
    Uri,
    WorkspaceConfiguration,
    type WorkspaceFolder
} from 'vscode';
import { IJupyterKernelSpec, LocalKernelSpecConnectionMetadata } from '../../types';
import { noop } from '../../../test/core';
import { assert } from 'chai';
import { IKernelLauncher, IKernelProcess } from '../types';
import {
    IDisposable,
    ReadWrite,
    type IConfigurationService,
    type IWatchableJupyterSettings
} from '../../../platform/common/types';
import { dispose } from '../../../platform/common/utils/lifecycle';
import { resolvableInstance, uriEquals } from '../../../test/datascience/helpers';
import { waitForCondition } from '../../../test/common';
import { KernelConnectionTimeoutError } from '../../errors/kernelConnectionTimeoutError';
import { RawSessionConnection } from './rawSessionConnection.node';
import { createDeferred } from '../../../platform/common/utils/async';
import { mockedVSCodeNamespaces, resetVSCodeMocks } from '../../../test/vscode-mock';
import type { IFileSystem } from '../../../platform/common/platform/types';
import { computeLocalWorkingDirectory } from './kernelWorkingDirectory.node';

const jupyterLabKernel =
    require('@jupyterlab/services/lib/kernel/default') as typeof import('@jupyterlab/services/lib/kernel/default');

suite('Raw Session & Raw Kernel Connection', () => {
    let session: RawSessionConnection;
    let kernelLauncher: IKernelLauncher;
    let token: CancellationTokenSource;
    let kernelProcess: IKernelProcess;
    let kernel: Kernel.IKernelConnection;
    let exitedEvent: EventEmitter<{
        exitCode?: number | undefined;
        reason?: string | undefined;
        stderr: string;
    }>;
    let onDidDispose: EventEmitter<void>;
    const launchTimeout = 1_000;
    let disposables: IDisposable[] = [];
    let kernelConnectionMetadata: LocalKernelSpecConnectionMetadata;
    const OldKernelConnectionClass = jupyterLabKernel.KernelConnection;
    const kernelInfo: KernelMessage.IInfoReply = {
        banner: '',
        help_links: [],
        implementation: '',
        implementation_version: '',
        language_info: { name: '', version: '' },
        protocol_version: '',
        status: 'ok'
    };
    const kernelInfoResponse: KernelMessage.IInfoReplyMsg = {
        channel: 'shell',
        header: {
            date: '',
            msg_id: '1',
            msg_type: 'kernel_info_reply',
            session: '',
            username: '',
            version: ''
        },
        content: kernelInfo,
        metadata: {},
        parent_header: {
            date: '',
            msg_id: '1',
            msg_type: 'kernel_info_request',
            session: '',
            username: '',
            version: ''
        }
    };
    const someIOPubMessage: KernelMessage.IIOPubMessage<KernelMessage.IOPubMessageType> = {
        header: {
            date: '',
            msg_id: '1',
            msg_type: 'status',
            session: '',
            username: '',
            version: ''
        },
        channel: 'iopub',
        content: {
            status: 'ok'
        } as any,
        metadata: {},
        parent_header: {
            date: '',
            msg_id: '1',
            msg_type: 'kernel_info_request',
            session: '',
            username: '',
            version: ''
        }
    };
    function createKernelProcess() {
        const kernelProcess = mock<IKernelProcess>();
        let disposed = false;
        when(kernelProcess.canInterrupt).thenReturn(true);
        when(kernelProcess.connection).thenReturn({
            control_port: 1,
            hb_port: 2,
            iopub_port: 3,
            ip: '123',
            key: '',
            shell_port: 4,
            signature_scheme: 'hmac-sha256',
            stdin_port: 5,
            transport: 'tcp'
        });
        when(kernelProcess.isDisposed).thenCall(() => disposed);
        when(kernelProcess.dispose()).thenCall(() => {
            disposed = true;
            onDidDispose.fire();
        });
        when(kernelProcess.exited).thenReturn(exitedEvent.event);
        when(kernelProcess.onDidDispose).thenReturn(onDidDispose.event);
        when(kernelProcess.canInterrupt).thenReturn(true);
        when(kernelProcess.interrupt()).thenResolve();
        when(kernelProcess.kernelConnectionMetadata).thenReturn(kernelConnectionMetadata);
        when(kernelProcess.pid).thenReturn(9999);
        return kernelProcess;
    }
    function createKernel() {
        const kernel = mock<Kernel.IKernelConnection>();
        const iopubMessage =
            mock<ISignal<Kernel.IKernelConnection, KernelMessage.IIOPubMessage<KernelMessage.IOPubMessageType>>>();
        let ioPubHandlers: ((_: unknown, msg: any) => {})[] = [];
        when(iopubMessage.connect(anything())).thenCall((handler) => ioPubHandlers.push(handler));
        when(iopubMessage.disconnect(anything())).thenCall(
            (handler) => (ioPubHandlers = ioPubHandlers.filter((h) => h !== handler))
        );
        when(kernel.status).thenReturn('idle');
        when(kernel.connectionStatus).thenReturn('connected');
        when(kernel.statusChanged).thenReturn(new Signal<Kernel.IKernelConnection, Kernel.Status>(instance(kernel)));
        // when(kernel.statusChanged).thenReturn(instance(mock<ISignal<Kernel.IKernelConnection, Kernel.Status>>()));
        when(kernel.iopubMessage).thenReturn(instance(iopubMessage));
        when(kernel.anyMessage).thenReturn({ connect: noop, disconnect: noop } as any);
        when(kernel.unhandledMessage).thenReturn(
            instance(mock<ISignal<Kernel.IKernelConnection, KernelMessage.IMessage<KernelMessage.MessageType>>>())
        );
        when(kernel.disposed).thenReturn(instance(mock<ISignal<Kernel.IKernelConnection, void>>()));
        when(kernel.pendingInput).thenReturn(instance(mock<ISignal<Kernel.IKernelConnection, boolean>>()));
        when(kernel.connectionStatusChanged).thenReturn(
            instance(mock<ISignal<Kernel.IKernelConnection, Kernel.ConnectionStatus>>())
        );
        when(kernel.info).thenResolve(kernelInfo);
        when(kernel.shutdown()).thenResolve();
        when(kernel.requestKernelInfo()).thenCall(async () => {
            ioPubHandlers.forEach((handler) => handler(instance(kernel), someIOPubMessage));
            return kernelInfoResponse;
        });
        const deferred = createDeferred<void>();
        disposables.push(new Disposable(() => deferred.resolve()));
        when(kernel.sendControlMessage(anything(), true, true)).thenReturn({ done: deferred.promise } as any);
        when(kernel.connectionStatus).thenReturn('connected');

        jupyterLabKernel.KernelConnection = function (options: { serverSettings: ServerConnection.ISettings }) {
            new options.serverSettings.WebSocket('http://1234');
            return instance(kernel);
        } as any;

        return kernel;
    }
    setup(() => {
        kernelConnectionMetadata = LocalKernelSpecConnectionMetadata.create({
            id: '1234',
            kernelSpec: {
                argv: ['r'],
                display_name: 'Hello',
                executable: 'r',
                name: 'R'
            }
        });
        exitedEvent = new EventEmitter<{
            exitCode?: number | undefined;
            reason?: string | undefined;
            stderr: string;
        }>();
        disposables.push(exitedEvent);
        onDidDispose = new EventEmitter<void>();
        disposables.push(onDidDispose);
        jupyterLabKernel.KernelConnection = OldKernelConnectionClass;
        const workspaceConfig = mock<WorkspaceConfiguration>();
        when(workspaceConfig.get(anything(), anything())).thenCall((_, defaultValue) => defaultValue);
        when(mockedVSCodeNamespaces.workspace.getConfiguration(anything())).thenReturn(instance(workspaceConfig));
        token = new CancellationTokenSource();
        disposables.push(token);
        session = mock<RawSessionConnection>();
        kernelProcess = createKernelProcess();
        kernelLauncher = mock<IKernelLauncher>();
        kernel = createKernel();
        when(kernelLauncher.launch(anything(), anything(), anything(), anything(), anything())).thenResolve(
            resolvableInstance(kernelProcess)
        );

        session = new RawSessionConnection(
            Uri.file('one.ipynb'),
            instance(kernelLauncher),
            Uri.file(''),
            kernelConnectionMetadata,
            launchTimeout,
            'notebook'
        );
    });

    teardown(async () => {
        jupyterLabKernel.KernelConnection = OldKernelConnectionClass;
        sinon.reset();
        disposables = dispose(disposables);
        await session
            .shutdown()
            .catch(noop)
            .finally(() => session.dispose());
    });
    suite('Start', async () => {
        let startupToken: CancellationTokenSource;
        setup(async () => {
            startupToken = new CancellationTokenSource();
            disposables.push(startupToken);
        });
        test('Verify kernel Status', async () => {
            await session.startKernel({ token: startupToken.token });

            when(kernel.status).thenReturn('idle');
            assert.strictEqual(session.status, 'idle');
        });
        test('Verify startup times out', async () => {
            const clock = sinon.useFakeTimers();
            disposables.push(new Disposable(() => clock.restore()));
            when(kernel.requestKernelInfo()).thenCall(() => {
                clock.tick(launchTimeout);
                return new Promise(noop);
            });
            const promise = session.startKernel({ token: startupToken.token });
            clock.runAll();

            await assert.isRejected(promise, new KernelConnectionTimeoutError(kernelConnectionMetadata).message);
        }).timeout(2_000);
        test('Verify startup can be cancelled', async () => {
            const clock = sinon.useFakeTimers();
            disposables.push(new Disposable(() => clock.restore()));
            when(kernel.requestKernelInfo()).thenCall(() => {
                clock.tick(launchTimeout);
                return new Promise(noop);
            });
            const promise = session.startKernel({ token: startupToken.token });
            clock.runAll();

            startupToken.cancel();
            await assert.isRejected(promise, new CancellationError().message);
        }).timeout(2_000);
        test('Verify startup can be cancelled (passing an already cancelled token', async () => {
            startupToken.cancel();
            const promise = session.startKernel({ token: startupToken.token });

            await assert.isRejected(promise, new CancellationError().message);
        }).timeout(2_000);
    });
    suite('After Start', async () => {
        setup(async () => {
            const startupToken = new CancellationTokenSource();
            disposables.push(startupToken);
            await session.startKernel({ token: startupToken.token });
        });
        test('Verify kernel Status', async () => {
            when(kernel.status).thenReturn('idle');
            assert.strictEqual(session.status, 'idle');

            when(kernel.status).thenReturn('busy');
            assert.strictEqual(session.status, 'busy');
        });
        test('Kernel Dies when the Kernel process dies', async () => {
            let disposed = false;
            const statuses: Kernel.Status[] = [];
            session.kernel!.statusChanged.connect((_, s) => statuses.push(s));
            session.kernel!.disposed.connect(() => (disposed = true));

            exitedEvent.fire({ exitCode: 1, reason: 'Killed', stderr: '' });

            await waitForCondition(
                () => !disposed && statuses.join(',') === 'dead',
                1_000,
                () => `Kernel is not dead, Kernel Disposed = ${disposed} && Kernel Status = ${statuses.join(',')}`
            );
            assert.strictEqual(session.status, 'dead');
            assert.strictEqual(session.isDisposed, false);
            assert.strictEqual(session.kernel?.isDisposed, false);
            assert.strictEqual(session.kernel?.status, 'dead');
        });
        test('Dispose', async () => {
            let disposed = false;
            const statuses: Kernel.Status[] = [];
            session.kernel!.statusChanged.connect((_, s) => statuses.push(s));
            session.disposed.connect(() => (disposed = true));

            session.dispose();

            await waitForCondition(
                () => disposed && statuses.join(',') === 'dead' && session.status === 'dead',
                1_000,
                () => `Session not terminated, Status = ${statuses.join(',')} and current status = ${session.status}`
            );
            assert.strictEqual(session.kernel?.isDisposed, true);
            assert.strictEqual(session.kernel?.status, 'dead');
            verify(kernelProcess.dispose()).once();
        });
        test('Shutdown', async () => {
            let disposed = false;
            const statuses: Kernel.Status[] = [];
            session.kernel!.statusChanged.connect((_, s) => statuses.push(s));
            session.disposed.connect(() => (disposed = true));

            await session.shutdown();

            assert.strictEqual(session.status, 'dead');
            assert.deepEqual(statuses, ['dead']);
            assert.strictEqual(disposed, false);
            verify(kernelProcess.dispose()).once();
        });
        test('Restart', async () => {
            const newKernel = createKernel();
            const newKernelProcess = createKernelProcess();
            when(kernelLauncher.launch(anything(), anything(), anything(), anything(), anything())).thenResolve(
                resolvableInstance(newKernelProcess)
            );

            const statuses: Kernel.Status[] = [];
            let disposed = false;
            session.statusChanged.connect((_, s) => statuses.push(s));
            session.disposed.connect(() => (disposed = true));

            await session.kernel?.restart();

            assert.strictEqual(session.status, 'idle');
            assert.deepEqual(statuses, ['restarting', 'idle']);
            assert.strictEqual(disposed, false);
            verify(kernelProcess.dispose()).once();

            // Verify we return the status of the new kernel and not the old kernel
            when(kernel.status).thenReturn('busy');
            assert.strictEqual(session.status, 'idle');
            when(newKernel.status).thenReturn('busy');
            assert.strictEqual(session.status, 'busy');
        });
        test('Restart Timeout', async () => {
            const newKernel = createKernel();
            const newKernelProcess = createKernelProcess();
            when(kernelLauncher.launch(anything(), anything(), anything(), anything(), anything())).thenResolve(
                resolvableInstance(newKernelProcess)
            );

            const statuses: Kernel.Status[] = [];
            let disposed = false;
            session.statusChanged.connect((_, s) => statuses.push(s));
            session.disposed.connect(() => (disposed = true));

            await session.kernel?.restart();

            assert.strictEqual(session.status, 'idle');
            assert.deepEqual(statuses, ['restarting', 'idle']);
            assert.strictEqual(disposed, false);
            verify(kernelProcess.dispose()).once();

            // Verify we return the status of the new kernel and not the old kernel
            when(kernel.status).thenReturn('busy');
            assert.strictEqual(session.status, 'idle');
            when(newKernel.status).thenReturn('busy');
            assert.strictEqual(session.status, 'busy');
        });
        test('Shutdown & then Restart', async () => {
            let disposed = false;
            const statuses: Kernel.Status[] = [];
            session.kernel!.statusChanged.connect((_, s) => statuses.push(s));
            session.disposed.connect(() => (disposed = true));

            await session.shutdown();

            assert.strictEqual(session.status, 'dead');
            assert.deepEqual(statuses, ['dead']);
            assert.strictEqual(disposed, false);
            assert.strictEqual(session.kernel?.isDisposed, false);
            assert.strictEqual(session.kernel?.status, 'dead');
            verify(kernelProcess.dispose()).once();

            const newKernel = createKernel();
            const newKernelProcess = createKernelProcess();
            when(kernelLauncher.launch(anything(), anything(), anything(), anything(), anything())).thenResolve(
                resolvableInstance(newKernelProcess)
            );

            const statusesOfNewKernel: Kernel.Status[] = [];
            session.statusChanged.connect((_, s) => statusesOfNewKernel.push(s));
            session.disposed.connect(() => (disposed = true));

            await session.kernel?.restart();

            assert.strictEqual(session.status, 'idle');
            assert.deepEqual(statusesOfNewKernel, ['restarting', 'idle']);
            assert.strictEqual(disposed, false);
            verify(kernelProcess.dispose()).atLeast(1);

            // Verify we return the status of the new kernel and not the old kernel
            when(kernel.status).thenReturn('busy');
            assert.strictEqual(session.status, 'idle');
            when(newKernel.status).thenReturn('busy');
            assert.strictEqual(session.status, 'busy');
        });
        test('Restart after kernel status turns dead', async () => {
            let disposed = false;
            const statuses: Kernel.Status[] = [];
            session.kernel!.statusChanged.connect((_, s) => statuses.push(s));
            session.disposed.connect(() => (disposed = true));

            when(kernel.status).thenReturn('dead');
            (session.kernel!.statusChanged as Signal<Kernel.IKernelConnection, Kernel.Status>).emit('dead');

            assert.strictEqual(session.status, 'dead');
            assert.deepEqual(statuses, ['dead']);
            assert.strictEqual(disposed, false);
            verify(kernelProcess.dispose()).never();

            const newKernel = createKernel();
            const newKernelProcess = createKernelProcess();
            when(kernelLauncher.launch(anything(), anything(), anything(), anything(), anything())).thenResolve(
                resolvableInstance(newKernelProcess)
            );

            const statusesOfNewKernel: Kernel.Status[] = [];
            session.statusChanged.connect((_, s) => statusesOfNewKernel.push(s));
            session.disposed.connect(() => (disposed = true));

            await session.kernel?.restart();

            assert.strictEqual(session.status, 'idle');
            assert.deepEqual(statusesOfNewKernel, ['restarting', 'idle']);
            assert.strictEqual(disposed, false);
            verify(kernelProcess.dispose()).atLeast(1);

            // Verify we return the status of the new kernel and not the old kernel
            when(kernel.status).thenReturn('busy');
            assert.strictEqual(session.status, 'idle');
            when(newKernel.status).thenReturn('busy');
            assert.strictEqual(session.status, 'busy');
        });
        test('Restart after kernel is shutdown', async () => {
            let disposed = false;
            const statuses: Kernel.Status[] = [];
            session.kernel!.statusChanged.connect((_, s) => statuses.push(s));
            session.disposed.connect(() => (disposed = true));

            await session.kernel!.shutdown();

            assert.strictEqual(session.status, 'dead');
            assert.deepEqual(statuses, ['dead']);
            assert.strictEqual(disposed, false);
            assert.strictEqual(session.kernel?.isDisposed, false);
            assert.strictEqual(session.kernel?.status, 'dead');
            verify(kernelProcess.dispose()).once();

            const newKernel = createKernel();
            const newKernelProcess = createKernelProcess();
            when(kernelLauncher.launch(anything(), anything(), anything(), anything(), anything())).thenResolve(
                resolvableInstance(newKernelProcess)
            );

            const statusesOfNewKernel: Kernel.Status[] = [];
            session.statusChanged.connect((_, s) => statusesOfNewKernel.push(s));
            session.disposed.connect(() => (disposed = true));

            await session.kernel?.restart();

            assert.strictEqual(session.status, 'idle');
            assert.deepEqual(statusesOfNewKernel, ['restarting', 'idle']);
            assert.strictEqual(disposed, false);
            verify(kernelProcess.dispose()).atLeast(1);

            // Verify we return the status of the new kernel and not the old kernel
            when(kernel.status).thenReturn('busy');
            assert.strictEqual(session.status, 'idle');
            when(newKernel.status).thenReturn('busy');
            assert.strictEqual(session.status, 'busy');
        });
        test('Interrupt the process', async () => {
            when(kernelProcess.canInterrupt).thenReturn(true);
            when(kernelProcess.interrupt()).thenResolve();

            await session.kernel?.interrupt();

            verify(kernelProcess.interrupt()).once();
        });
        test('Send and interrupt message', async () => {
            (kernelConnectionMetadata.kernelSpec as ReadWrite<IJupyterKernelSpec>).interrupt_mode = 'message';
            when(kernelProcess.canInterrupt).thenReturn(false);
            let request: KernelMessage.IShellMessage<KernelMessage.ShellMessageType> | undefined;
            when(kernel.sendShellMessage(anything(), anything(), anything())).thenCall((msg) => {
                request = msg;
                return { done: Promise.resolve() } as any;
            });

            await session.kernel?.interrupt();

            verify(kernelProcess.interrupt()).never();
            verify(kernel.sendShellMessage(anything(), anything(), anything())).once();
            assert.strictEqual(request?.header.msg_type, 'interrupt_request');
        });
    });
});

suite('Raw Session & Raw Kernel Connection', () => {
    suite('KernelWorkingFolder', function () {
        let configService: IConfigurationService;
        let fs: IFileSystem;
        let settings: IWatchableJupyterSettings;
        let workspaceFolder: WorkspaceFolder;
        setup(() => {
            configService = mock<IConfigurationService>();
            settings = mock<IWatchableJupyterSettings>();
            fs = mock<IFileSystem>();
            when(configService.getSettings(anything())).thenReturn(instance(settings));
        });
        teardown(() => {
            resetVSCodeMocks();
        });
        workspaceFolder = { index: 0, name: 'one', uri: Uri.file(__dirname) };
        test(`Has working folder`, async () => {
            when(settings.notebookFileRoot).thenReturn(__dirname);
            when(fs.exists(anything())).thenResolve(true);
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder]);

            const cwd = await computeLocalWorkingDirectory(Uri.file('test.py'), instance(configService), instance(fs));

            assert.strictEqual(Uri.file(cwd!).fsPath, Uri.file(__dirname).fsPath);
        });
        test('No working folder if setting `notebookFileRoot` is invalid', async () => {
            when(settings.notebookFileRoot).thenReturn('bogus value');
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder]);
            when(fs.exists(anything())).thenResolve(false);

            const cwd = await computeLocalWorkingDirectory(Uri.file('test.py'), instance(configService), instance(fs));

            assert.isUndefined(cwd);
        });
        test('Has working folder and points to first workspace folder if setting `notebookFileRoot` points to non-existent path', async () => {
            when(settings.notebookFileRoot).thenReturn(Uri.joinPath(Uri.file(__dirname), 'xyz1234').fsPath);
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([workspaceFolder]);
            when(fs.exists(anything())).thenResolve(false);
            when(fs.exists(uriEquals(__dirname))).thenResolve(true);

            const cwd = await computeLocalWorkingDirectory(Uri.file('test.py'), instance(configService), instance(fs));

            assert.strictEqual(cwd, workspaceFolder.uri.fsPath);
        });
        test('Has working folder and points to folder of kernel resource when there are no workspace folders', async () => {
            when(settings.notebookFileRoot).thenReturn(Uri.joinPath(Uri.file(__dirname), 'xyz1234').fsPath);
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([]);
            when(fs.exists(anything())).thenResolve(false);
            when(fs.exists(uriEquals(__dirname))).thenResolve(false);
            const kernelResourceUri = Uri.joinPath(Uri.file(__dirname), 'dev', 'kernel.ipynb');
            when(fs.exists(uriEquals(kernelResourceUri))).thenResolve(true);
            when(fs.exists(uriEquals(Uri.joinPath(Uri.file(__dirname), 'dev')))).thenResolve(true);

            const cwd = await computeLocalWorkingDirectory(kernelResourceUri, instance(configService), instance(fs));

            assert.strictEqual(cwd, Uri.joinPath(Uri.file(__dirname), 'dev').fsPath);
        });
        test('No working folder if no workspace folders', async () => {
            when(settings.notebookFileRoot).thenReturn(__dirname);
            when(mockedVSCodeNamespaces.workspace.workspaceFolders).thenReturn([]);
            when(fs.exists(anything())).thenResolve(false);

            const cwd = await computeLocalWorkingDirectory(Uri.file('test.ipy'), instance(configService), instance(fs));

            assert.isUndefined(cwd);
        });
    });
});
