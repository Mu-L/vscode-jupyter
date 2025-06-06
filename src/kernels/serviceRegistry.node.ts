// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { IExtensionSyncActivationService } from '../platform/activation/types';
import { IPythonExtensionChecker } from '../platform/api/types';
import { Identifiers, isPreReleaseVersion } from '../platform/common/constants';
import { IServiceManager } from '../platform/ioc/types';
import { setSharedProperty } from '../telemetry';
import { Activation } from './jupyter/interpreter/activation.node';
import { CellOutputDisplayIdTracker } from './execution/cellDisplayIdTracker';
import { PreferredRemoteKernelIdProvider } from './jupyter/connection/preferredRemoteKernelIdProvider';
import { RemoteJupyterServerMruUpdate } from './jupyter/connection/remoteJupyterServerMruUpdate';
import { ServerPreload } from './jupyter/launcher/serverPreload.node';
import { registerTypes as registerJupyterTypes } from './jupyter/serviceRegistry.node';
import { KernelAutoReconnectMonitor } from './kernelAutoReConnectMonitor';
import { KernelAutoRestartMonitor } from './kernelAutoRestartMonitor.node';
import { KernelCrashMonitor } from './kernelCrashMonitor';
import { KernelDependencyService } from './kernelDependencyService.node';
import { KernelFinder } from './kernelFinder';
import { KernelProvider, ThirdPartyKernelProvider } from './kernelProvider.node';
import { KernelRefreshIndicator } from './kernelRefreshIndicator.node';
import { KernelStartupCodeProviders } from './kernelStartupCodeProviders.node';
import { KernelStartupTelemetry } from './kernelStartupTelemetry.node';
import { IKernelStatusProvider, KernelStatusProvider } from './kernelStatusProvider';
import { ContributedLocalKernelSpecFinder } from './raw/finder/contributedLocalKernelSpecFinder.node';
import { JupyterPaths } from './raw/finder/jupyterPaths.node';
import { LocalKnownPathKernelSpecFinder } from './raw/finder/localKnownPathKernelSpecFinder.node';
import { LocalPythonAndRelatedNonPythonKernelSpecFinder } from './raw/finder/localPythonAndRelatedNonPythonKernelSpecFinder.node';
import { PythonKernelInterruptDaemon } from './raw/finder/pythonKernelInterruptDaemon.node';
import { TrustedKernelPaths } from './raw/finder/trustedKernelPaths.node';
import { ITrustedKernelPaths } from './raw/finder/types';
import { KernelEnvironmentVariablesService } from './raw/launcher/kernelEnvVarsService.node';
import { KernelLauncher } from './raw/launcher/kernelLauncher.node';
import { RawKernelSessionFactory } from './raw/session/rawKernelSessionFactory.node';
import { RawNotebookSupportedService } from './raw/session/rawNotebookSupportedService.node';
import { IKernelLauncher, IRawKernelSessionFactory, IRawNotebookSupportedService } from './raw/types';
import {
    IKernelDependencyService,
    IKernelFinder,
    IKernelProvider,
    IKernelWorkingDirectory,
    IStartupCodeProviders,
    IThirdPartyKernelProvider
} from './types';
import { JupyterVariables } from './variables/jupyterVariables';
import { IJupyterVariables } from './variables/types';
import { LastCellExecutionTracker } from './execution/lastCellExecutionTracker';
import { ClearJupyterServersCommand } from './jupyter/clearJupyterServersCommand';
import { KernelChatStartupCodeProvider } from './chat/kernelStartupCodeProvider';
import { KernelWorkingDirectory } from './raw/session/kernelWorkingDirectory.node';

export function registerTypes(serviceManager: IServiceManager, isDevMode: boolean) {
    serviceManager.addSingleton<IExtensionSyncActivationService>(IExtensionSyncActivationService, Activation);
    serviceManager.addSingleton<IExtensionSyncActivationService>(IExtensionSyncActivationService, ServerPreload);
    serviceManager.addSingleton<IRawNotebookSupportedService>(
        IRawNotebookSupportedService,
        RawNotebookSupportedService
    );
    serviceManager.addSingleton<PreferredRemoteKernelIdProvider>(
        PreferredRemoteKernelIdProvider,
        PreferredRemoteKernelIdProvider
    );
    serviceManager.addSingleton<IRawKernelSessionFactory>(IRawKernelSessionFactory, RawKernelSessionFactory);
    serviceManager.addSingleton<IKernelLauncher>(IKernelLauncher, KernelLauncher);
    serviceManager.addSingleton<KernelEnvironmentVariablesService>(
        KernelEnvironmentVariablesService,
        KernelEnvironmentVariablesService
    );
    serviceManager.addSingleton<IKernelFinder>(IKernelFinder, KernelFinder);
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        ContributedLocalKernelSpecFinder
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        RemoteJupyterServerMruUpdate
    );

    serviceManager.addSingleton<JupyterPaths>(JupyterPaths, JupyterPaths);
    serviceManager.addSingleton<ITrustedKernelPaths>(ITrustedKernelPaths, TrustedKernelPaths);
    serviceManager.addSingleton<LocalKnownPathKernelSpecFinder>(
        LocalKnownPathKernelSpecFinder,
        LocalKnownPathKernelSpecFinder
    );
    serviceManager.addBinding(LocalKnownPathKernelSpecFinder, IExtensionSyncActivationService);

    serviceManager.addSingleton<LocalPythonAndRelatedNonPythonKernelSpecFinder>(
        LocalPythonAndRelatedNonPythonKernelSpecFinder,
        LocalPythonAndRelatedNonPythonKernelSpecFinder
    );

    serviceManager.addSingleton<IKernelStatusProvider>(IKernelStatusProvider, KernelStatusProvider);
    serviceManager.addBinding(IKernelStatusProvider, IExtensionSyncActivationService);
    serviceManager.addSingleton<IJupyterVariables>(IJupyterVariables, JupyterVariables, Identifiers.ALL_VARIABLES);

    serviceManager.addSingleton<IKernelDependencyService>(IKernelDependencyService, KernelDependencyService);
    serviceManager.addSingleton<IExtensionSyncActivationService>(IExtensionSyncActivationService, KernelCrashMonitor);
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        KernelRefreshIndicator
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        KernelAutoReconnectMonitor
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        KernelAutoRestartMonitor
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        KernelStartupTelemetry
    );
    serviceManager.addSingleton<IKernelProvider>(IKernelProvider, KernelProvider);
    serviceManager.addSingleton<IThirdPartyKernelProvider>(IThirdPartyKernelProvider, ThirdPartyKernelProvider);

    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        ClearJupyterServersCommand
    );
    serviceManager.addSingleton<LastCellExecutionTracker>(LastCellExecutionTracker, LastCellExecutionTracker);
    serviceManager.addBinding(LastCellExecutionTracker, IExtensionSyncActivationService);

    // Subdirectories
    registerJupyterTypes(serviceManager, isDevMode);
    setSharedProperty('isInsiderExtension', isPreReleaseVersion() ? 'true' : 'false');

    const isPythonExtensionInstalled = serviceManager.get<IPythonExtensionChecker>(IPythonExtensionChecker);
    setSharedProperty(
        'isPythonExtensionInstalled',
        isPythonExtensionInstalled.isPythonExtensionInstalled ? 'true' : 'false'
    );
    const rawService = serviceManager.get<IRawNotebookSupportedService>(IRawNotebookSupportedService);
    setSharedProperty('rawKernelSupported', rawService.isSupported ? 'true' : 'false');
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        CellOutputDisplayIdTracker
    );
    serviceManager.addSingleton<IStartupCodeProviders>(IStartupCodeProviders, KernelStartupCodeProviders);
    serviceManager.addSingleton<PythonKernelInterruptDaemon>(PythonKernelInterruptDaemon, PythonKernelInterruptDaemon);
    serviceManager.addSingleton<IKernelWorkingDirectory>(IKernelWorkingDirectory, KernelWorkingDirectory);
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        KernelChatStartupCodeProvider
    );
}
