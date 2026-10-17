/**
 * Open WebTV - Strict TypeScript Definitions for Samsung Tizen OS & WebAPIs
 *
 * Covers Tizen 2.4+ through 8.0 Smart TV APIs:
 * - `tizen.application` (Application, ApplicationControl, RequestedApplicationControl)
 * - `tizen.messageport` (LocalMessagePort, RemoteMessagePort, IPC key-value payloads)
 * - `tizen.tvinputdevice` (Remote control hardware media key registration)
 * - `webapis.preview` (Samsung Smart Hub Preview `bg_service` JSON setter)
 * - `webapis.avplay` (Samsung hardware-accelerated media player for MKV/HEVC/AC3/HLS)
 */

export interface TizenKeyValueMessage {
  readonly key: string;
  readonly value: string | boolean | number | readonly string[];
}

export interface TizenLocalMessagePort {
  addMessagePortListener(
    listener: (data: readonly TizenKeyValueMessage[], remotePort?: TizenRemoteMessagePort | null) => void
  ): number;
  removeMessagePortListener?(watchId: number): void;
}

export interface TizenRemoteMessagePort {
  sendMessage(
    data: readonly TizenKeyValueMessage[],
    localPort?: TizenLocalMessagePort | null
  ): void;
}

export interface TizenMessagePortManager {
  requestLocalMessagePort(portName: string): TizenLocalMessagePort;
  requestRemoteMessagePort(appId: string, portName: string): TizenRemoteMessagePort;
}

export interface TizenApplicationControlData {
  readonly key: string;
  readonly value: readonly string[];
}

export interface TizenApplicationControlDataConstructor {
  new (key: string, value: readonly string[]): TizenApplicationControlData;
}

export interface TizenApplicationControl {
  readonly operation: string;
  readonly uri?: string | null;
  readonly mime?: string | null;
  readonly category?: string | null;
  readonly data: readonly TizenApplicationControlData[];
}

export interface TizenApplicationControlConstructor {
  new (
    operation: string,
    uri?: string | null,
    mime?: string | null,
    category?: string | null,
    data?: readonly TizenApplicationControlData[]
  ): TizenApplicationControl;
}

export interface TizenRequestedApplicationControl {
  readonly appControl: TizenApplicationControl;
  replyResult?(data?: readonly TizenApplicationControlData[]): void;
  replyFailure?(): void;
}

export interface TizenCurrentApplication {
  exit(): void;
  hide?(): void;
  getRequestedAppControl(): TizenRequestedApplicationControl | null;
}

export interface TizenError {
  readonly name?: string;
  readonly message: string;
  readonly code?: number;
}

export interface TizenApplicationManager {
  getCurrentApplication(): TizenCurrentApplication;
  launchAppControl(
    appControl: TizenApplicationControl,
    appId: string | null,
    successCallback?: () => void,
    errorCallback?: (err: TizenError) => void
  ): void;
}

export interface TizenTvInputDeviceManager {
  registerKey(keyName: string): void;
  unregisterKey?(keyName: string): void;
}

export interface TizenNamespace {
  readonly application?: TizenApplicationManager;
  readonly messageport?: TizenMessagePortManager;
  readonly tvinputdevice?: TizenTvInputDeviceManager;
  readonly ApplicationControl?: TizenApplicationControlConstructor;
  readonly ApplicationControlData?: TizenApplicationControlDataConstructor;
}

export interface WebApisPreviewManager {
  setPreviewData(
    jsonPayload: string,
    successCallback?: () => void,
    errorCallback?: (err: TizenError) => void
  ): void;
}

export interface AVPlayTrackInfo {
  readonly type: 'AUDIO' | 'VIDEO' | 'TEXT' | string;
  readonly index: number;
  readonly extra_info?: string;
}

export interface AVPlayListener {
  onbufferingstart?: () => void;
  onbufferingprogress?: (percent: number) => void;
  onbufferingcomplete?: () => void;
  oncurrentplaytime?: (currentTimeMs: number) => void;
  onevent?: (eventType: string, eventData: string) => void;
  onerror?: (eventType: string) => void;
  onsubtitlechange?: (durationMs: number, text: string, type: string, attriCount: string) => void;
  ondrmevent?: (drmEvent: string, drmData: unknown) => void;
  onstreamcompleted?: () => void;
}

export type AVPlayDisplayMethod =
  | 'PLAYER_DISPLAY_MODE_LETTER_BOX'
  | 'PLAYER_DISPLAY_MODE_FULL_SCREEN'
  | 'PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO';

export interface WebApisAVPlayManager {
  open(url: string): void;
  close(): void;
  prepare(): void;
  prepareAsync(successCallback?: () => void, errorCallback?: (err: TizenError) => void): void;
  play(): void;
  pause(): void;
  stop(): void;
  seekTo(milliseconds: number, successCallback?: () => void, errorCallback?: (err: TizenError) => void): void;
  jumpForward(milliseconds: number, successCallback?: () => void, errorCallback?: (err: TizenError) => void): void;
  jumpBackward(milliseconds: number, successCallback?: () => void, errorCallback?: (err: TizenError) => void): void;
  getDuration(): number;
  getCurrentTime?(): number;
  getState?(): string;
  setDisplayRect(x: number, y: number, width: number, height: number): void;
  setDisplayMethod(mode: AVPlayDisplayMethod): void;
  setListener(listener: AVPlayListener): void;
  getTotalTrackInfo?(): readonly AVPlayTrackInfo[];
  setSelectTrack?(trackType: string, trackIndex: number): void;
  setSpeed?(speed: number): void;
}

export interface WebApisNamespace {
  readonly preview?: WebApisPreviewManager;
  readonly avplay?: WebApisAVPlayManager;
}

export interface SmartHubPreviewTile {
  readonly title: string;
  readonly subtitle?: string;
  readonly image_ratio: '16by9' | '4by3' | '1by1' | '2by3';
  readonly image_url: string;
  readonly action_data: string;
  readonly is_playable: boolean;
  readonly position?: number;
}

export interface SmartHubPreviewSection {
  readonly title: string;
  readonly tiles: readonly SmartHubPreviewTile[];
}

export interface SmartHubPreviewPayload {
  readonly sections: readonly SmartHubPreviewSection[];
}

export interface ServiceConfig {
  readonly logServerOrigin: string;
  readonly clientAppId: string;
  readonly previewServiceId: string;
  readonly clientChannel: string;
  readonly serviceChannel: string;
  readonly defaultFeedUrl: string;
}

export interface LoggerLike {
  info(message: string, ...optionalParams: unknown[]): void;
  warn(message: string, ...optionalParams: unknown[]): void;
  error(message: string, ...optionalParams: unknown[]): void;
}

declare global {
  var tizen: TizenNamespace | undefined;
  var webapis: WebApisNamespace | undefined;
}
