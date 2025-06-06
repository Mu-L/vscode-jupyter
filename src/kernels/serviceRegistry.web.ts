// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { IExtensionSyncActivationService } from '../platform/activation/types';
import { IPythonExtensionChecker } from '../platform/api/types';
import { Identifiers, isPreReleaseVersion } from '../platform/common/constants';

import { IServiceManager } from '../platform/ioc/types';
import { setSharedProperty } from '../telemetry';
import { IRawNotebookSupportedService } from './raw/types';
import { KernelCrashMonitor } from './kernelCrashMonitor';
import { registerTypes as registerJupyterTypes } from './jupyter/serviceRegistry.web';
import { injectable } from 'inversify';
import {
    IKernelDependencyService,
    IKernelFinder,
    IKernelProvider,
    IStartupCodeProviders,
    IThirdPartyKernelProvider
} from './types';
import { KernelProvider, ThirdPartyKernelProvider } from './kernelProvider.web';
import { KernelFinder } from './kernelFinder';
import { PreferredRemoteKernelIdProvider } from './jupyter/connection/preferredRemoteKernelIdProvider';
import { IJupyterVariables } from './variables/types';
import { JupyterVariables } from './variables/jupyterVariables';
import { CellOutputDisplayIdTracker } from './execution/cellDisplayIdTracker';
import { KernelAutoReconnectMonitor } from './kernelAutoReConnectMonitor';
import { TrustedKernelPaths } from './raw/finder/trustedKernelPaths.web';
import { ITrustedKernelPaths } from './raw/finder/types';
import { IKernelStatusProvider, KernelStatusProvider } from './kernelStatusProvider';
import { KernelRefreshIndicator } from './kernelRefreshIndicator.web';
import { RemoteJupyterServerMruUpdate } from './jupyter/connection/remoteJupyterServerMruUpdate';
import { KernelDependencyService } from './kernelDependencyService.web';
import { KernelStartupCodeProviders } from './kernelStartupCodeProviders.web';
import { LastCellExecutionTracker } from './execution/lastCellExecutionTracker';
import { ClearJupyterServersCommand } from './jupyter/clearJupyterServersCommand';
import { KernelChatStartupCodeProvider } from './chat/kernelStartupCodeProvider';

@injectable()
class RawNotebookSupportedService implements IRawNotebookSupportedService {
    isSupported: boolean = false;
}

export function registerTypes(serviceManager: IServiceManager, isDevMode: boolean) {
    serviceManager.addSingleton<IRawNotebookSupportedService>(
        IRawNotebookSupportedService,
        RawNotebookSupportedService
    );
    setSharedProperty('isInsiderExtension', isPreReleaseVersion() ? 'true' : 'false');

    const isPythonExtensionInstalled = serviceManager.get<IPythonExtensionChecker>(IPythonExtensionChecker);
    setSharedProperty(
        'isPythonExtensionInstalled',
        isPythonExtensionInstalled.isPythonExtensionInstalled ? 'true' : 'false'
    );
    const rawService = serviceManager.get<IRawNotebookSupportedService>(IRawNotebookSupportedService);
    setSharedProperty('rawKernelSupported', rawService.isSupported ? 'true' : 'false');
    serviceManager.addSingleton<IStartupCodeProviders>(IStartupCodeProviders, KernelStartupCodeProviders);
    serviceManager.addSingleton<IJupyterVariables>(IJupyterVariables, JupyterVariables, Identifiers.ALL_VARIABLES);

    serviceManager.addSingleton<IExtensionSyncActivationService>(IExtensionSyncActivationService, KernelCrashMonitor);
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        KernelRefreshIndicator
    );
    serviceManager.addSingleton<IKernelStatusProvider>(IKernelStatusProvider, KernelStatusProvider);
    serviceManager.addBinding(IKernelStatusProvider, IExtensionSyncActivationService);
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        KernelAutoReconnectMonitor
    );
    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        RemoteJupyterServerMruUpdate
    );

    serviceManager.addSingleton<IKernelProvider>(IKernelProvider, KernelProvider);
    serviceManager.addSingleton<ITrustedKernelPaths>(ITrustedKernelPaths, TrustedKernelPaths);
    serviceManager.addSingleton<IThirdPartyKernelProvider>(IThirdPartyKernelProvider, ThirdPartyKernelProvider);
    serviceManager.addSingleton<PreferredRemoteKernelIdProvider>(
        PreferredRemoteKernelIdProvider,
        PreferredRemoteKernelIdProvider
    );
    serviceManager.addSingleton<IKernelFinder>(IKernelFinder, KernelFinder);
    serviceManager.addSingleton<IKernelDependencyService>(IKernelDependencyService, KernelDependencyService);

    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        ClearJupyterServersCommand
    );
    serviceManager.addSingleton<LastCellExecutionTracker>(LastCellExecutionTracker, LastCellExecutionTracker);
    serviceManager.addBinding(LastCellExecutionTracker, IExtensionSyncActivationService);

    // Subdirectories
    registerJupyterTypes(serviceManager, isDevMode);

    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        CellOutputDisplayIdTracker
    );

    serviceManager.addSingleton<IExtensionSyncActivationService>(
        IExtensionSyncActivationService,
        KernelChatStartupCodeProvider
    );
}
