/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { IWorkbenchExtensionEnablementService, IWebExtensionsScannerService } from 'vs/workbench/services/extensionManagement/common/extensionManagement';
import { IRemoteAgentService } from 'vs/workbench/services/remote/common/remoteAgentService';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IExtensionService, IExtensionHost, toExtensionDescription, ExtensionRunningLocation, extensionRunningLocationToString } from 'vs/workbench/services/extensions/common/extensions';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { IFileService } from 'vs/platform/files/common/files';
import { IProductService } from 'vs/platform/product/common/productService';
import { AbstractExtensionService, ExtensionRunningPreference, extensionRunningPreferenceToString } from 'vs/workbench/services/extensions/common/abstractExtensionService';
import { RemoteExtensionHost, IRemoteExtensionHostDataProvider, IRemoteExtensionHostInitData } from 'vs/workbench/services/extensions/common/remoteExtensionHost';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { WebWorkerExtensionHost } from 'vs/workbench/services/extensions/browser/webWorkerExtensionHost';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ExtensionIdentifier, IExtensionDescription, ExtensionKind, IExtension, ExtensionType } from 'vs/platform/extensions/common/extensions';
import { FetchFileSystemProvider } from 'vs/workbench/services/extensions/browser/webWorkerFileSystemProvider';
import { Schemas } from 'vs/base/common/network';
import { DisposableStore } from 'vs/base/common/lifecycle';
import { IRemoteAuthorityResolverService } from 'vs/platform/remote/common/remoteAuthorityResolver';
import { ILifecycleService, LifecyclePhase } from 'vs/workbench/services/lifecycle/common/lifecycle';
import { IExtensionManagementService } from 'vs/platform/extensionManagement/common/extensionManagement';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { IExtensionManifestPropertiesService } from 'vs/workbench/services/extensions/common/extensionManifestPropertiesService';
import { IUserDataInitializationService } from 'vs/workbench/services/userData/browser/userDataInit';
import { IAutomatedWindow } from 'vs/platform/log/browser/log';
import { ILogService } from 'vs/platform/log/common/log';

export class ExtensionService extends AbstractExtensionService implements IExtensionService {

	private _disposables = new DisposableStore();
	private _remoteInitData: IRemoteExtensionHostInitData | null = null;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@INotificationService notificationService: INotificationService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IWorkbenchExtensionEnablementService extensionEnablementService: IWorkbenchExtensionEnablementService,
		@IFileService fileService: IFileService,
		@IProductService productService: IProductService,
		@IExtensionManagementService extensionManagementService: IExtensionManagementService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IConfigurationService configurationService: IConfigurationService,
		@IRemoteAuthorityResolverService private readonly _remoteAuthorityResolverService: IRemoteAuthorityResolverService,
		@IRemoteAgentService private readonly _remoteAgentService: IRemoteAgentService,
		@IWebExtensionsScannerService webExtensionsScannerService: IWebExtensionsScannerService,
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
		@IExtensionManifestPropertiesService extensionManifestPropertiesService: IExtensionManifestPropertiesService,
		@IUserDataInitializationService private readonly _userDataInitializationService: IUserDataInitializationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super(
			instantiationService,
			notificationService,
			environmentService,
			telemetryService,
			extensionEnablementService,
			fileService,
			productService,
			extensionManagementService,
			contextService,
			configurationService,
			extensionManifestPropertiesService,
			webExtensionsScannerService
		);

		this._runningLocation = new Map<string, ExtensionRunningLocation>();

		// Initialize installed extensions first and do it only after workbench is ready
		this._lifecycleService.when(LifecyclePhase.Ready).then(async () => {
			await this._userDataInitializationService.initializeInstalledExtensions(this._instantiationService);
			this._initialize();
		});

		this._initFetchFileSystem();
	}

	override dispose(): void {
		this._disposables.dispose();
		super.dispose();
	}

	protected async _scanSingleExtension(extension: IExtension): Promise<IExtensionDescription | null> {
		if (extension.location.scheme === Schemas.vscodeRemote) {
			return this._remoteAgentService.scanSingleExtension(extension.location, extension.type === ExtensionType.System);
		}

		const scannedExtension = await this._webExtensionsScannerService.scanExistingExtension(extension.location, extension.type);
		if (scannedExtension) {
			return toExtensionDescription(scannedExtension);
		}

		return null;
	}

	private _initFetchFileSystem(): void {
		const provider = new FetchFileSystemProvider();
		this._disposables.add(this._fileService.registerProvider(Schemas.http, provider));
		this._disposables.add(this._fileService.registerProvider(Schemas.https, provider));
	}

	private _createLocalExtensionHostDataProvider() {
		return {
			getInitData: async () => {
				const allExtensions = await this.getExtensions();
				const localWebWorkerExtensions = filterByRunningLocation(allExtensions, this._runningLocation, ExtensionRunningLocation.LocalWebWorker);
				return {
					autoStart: true,
					extensions: localWebWorkerExtensions
				};
			}
		};
	}

	private _createRemoteExtensionHostDataProvider(remoteAuthority: string): IRemoteExtensionHostDataProvider {
		return {
			remoteAuthority: remoteAuthority,
			getInitData: async () => {
				await this.whenInstalledExtensionsRegistered();
				return this._remoteInitData!;
			}
		};
	}

	protected _pickRunningLocation(extensionId: ExtensionIdentifier, extensionKinds: ExtensionKind[], isInstalledLocally: boolean, isInstalledRemotely: boolean, preference: ExtensionRunningPreference): ExtensionRunningLocation {
		const result = ExtensionService.pickRunningLocation(extensionKinds, isInstalledLocally, isInstalledRemotely, preference);
		this._logService.trace(`pickRunningLocation for ${extensionId.value}, extension kinds: [${extensionKinds.join(', ')}], isInstalledLocally: ${isInstalledLocally}, isInstalledRemotely: ${isInstalledRemotely}, preference: ${extensionRunningPreferenceToString(preference)} => ${extensionRunningLocationToString(result)}`);
		return result;
	}

	public static pickRunningLocation(extensionKinds: ExtensionKind[], isInstalledLocally: boolean, isInstalledRemotely: boolean, preference: ExtensionRunningPreference): ExtensionRunningLocation {
		const result: ExtensionRunningLocation[] = [];
		let canRunRemotely = false;
		for (const extensionKind of extensionKinds) {
			if (extensionKind === 'ui' && isInstalledRemotely) {
				// ui extensions run remotely if possible (but only as a last resort)
				if (preference === ExtensionRunningPreference.Remote) {
					return ExtensionRunningLocation.Remote;
				} else {
					canRunRemotely = true;
				}
			}
			if (extensionKind === 'workspace' && isInstalledRemotely) {
				// workspace extensions run remotely if possible
				if (preference === ExtensionRunningPreference.None || preference === ExtensionRunningPreference.Remote) {
					return ExtensionRunningLocation.Remote;
				} else {
					result.push(ExtensionRunningLocation.Remote);
				}
			}
			if (extensionKind === 'web' && isInstalledLocally) {
				// web worker extensions run in the local web worker if possible
				if (preference === ExtensionRunningPreference.None || preference === ExtensionRunningPreference.Local) {
					return ExtensionRunningLocation.LocalWebWorker;
				} else {
					result.push(ExtensionRunningLocation.LocalWebWorker);
				}
			}
		}
		if (canRunRemotely) {
			result.push(ExtensionRunningLocation.Remote);
		}
		return (result.length > 0 ? result[0] : ExtensionRunningLocation.None);
	}

	protected _createExtensionHosts(_isInitialStart: boolean): IExtensionHost[] {
		const result: IExtensionHost[] = [];

		const webWorkerExtHost = this._instantiationService.createInstance(WebWorkerExtensionHost, false, this._createLocalExtensionHostDataProvider());
		result.push(webWorkerExtHost);

		const remoteAgentConnection = this._remoteAgentService.getConnection();
		if (remoteAgentConnection) {
			const remoteExtHost = this._instantiationService.createInstance(RemoteExtensionHost, this._createRemoteExtensionHostDataProvider(remoteAgentConnection.remoteAuthority), this._remoteAgentService.socketFactory);
			result.push(remoteExtHost);
		}

		return result;
	}

	protected async _scanAndHandleExtensions(): Promise<void> {
		// fetch the remote environment
		let [localExtensions, remoteEnv, remoteExtensions] = await Promise.all([
			this._scanWebExtensions(),
			this._remoteAgentService.getEnvironment(),
			this._remoteAgentService.scanExtensions()
		]);
		localExtensions = this._checkEnabledAndProposedAPI(localExtensions, false);
		remoteExtensions = this._checkEnabledAndProposedAPI(remoteExtensions, false);

		const remoteAgentConnection = this._remoteAgentService.getConnection();
		this._runningLocation = this._runningLocationClassifier.determineRunningLocation(localExtensions, remoteExtensions);

		localExtensions = filterByRunningLocation(localExtensions, this._runningLocation, ExtensionRunningLocation.LocalWebWorker);
		remoteExtensions = filterByRunningLocation(remoteExtensions, this._runningLocation, ExtensionRunningLocation.Remote);

		const result = this._registry.deltaExtensions(remoteExtensions.concat(localExtensions), []);
		if (result.removedDueToLooping.length > 0) {
			this._logOrShowMessage(Severity.Error, nls.localize('looping', "The following extensions contain dependency loops and have been disabled: {0}", result.removedDueToLooping.map(e => `'${e.identifier.value}'`).join(', ')));
		}

		if (remoteEnv && remoteAgentConnection) {
			// save for remote extension's init data
			this._remoteInitData = {
				connectionData: this._remoteAuthorityResolverService.getConnectionData(remoteAgentConnection.remoteAuthority),
				pid: remoteEnv.pid,
				appRoot: remoteEnv.appRoot,
				extensionHostLogsPath: remoteEnv.extensionHostLogsPath,
				globalStorageHome: remoteEnv.globalStorageHome,
				workspaceStorageHome: remoteEnv.workspaceStorageHome,
				extensions: remoteExtensions,
				allExtensions: this._registry.getAllExtensionDescriptions()
			};
		}

		this._doHandleExtensionPoints(this._registry.getAllExtensionDescriptions());
	}

	public _onExtensionHostExit(code: number): void {
		// Dispose everything associated with the extension host
		this.stopExtensionHosts();

		const automatedWindow = window as unknown as IAutomatedWindow;
		if (typeof automatedWindow.codeAutomationExit === 'function') {
			automatedWindow.codeAutomationExit(code);
		}
	}
}

function filterByRunningLocation(extensions: IExtensionDescription[], runningLocation: Map<string, ExtensionRunningLocation>, desiredRunningLocation: ExtensionRunningLocation): IExtensionDescription[] {
	return extensions.filter(ext => runningLocation.get(ExtensionIdentifier.toKey(ext.identifier)) === desiredRunningLocation);
}

registerSingleton(IExtensionService, ExtensionService);
