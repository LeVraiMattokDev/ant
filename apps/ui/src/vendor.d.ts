// Minimal typings for untyped dependencies (only the members Ant uses).

declare module 'qrcode' {
  interface BitMatrix {
    size: number;
    get(row: number, col: number): number | boolean;
  }
  interface QRCodeInstance {
    modules: BitMatrix;
  }
  const QRCode: {
    create(text: string, options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' }): QRCodeInstance;
  };
  export default QRCode;
}

declare module '@novnc/novnc' {
  export interface RFBOptions {
    shared?: boolean;
    credentials?: { username?: string; password?: string; target?: string };
    wsProtocols?: string[];
  }
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RFBOptions);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    focusOnClick: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
    focus(options?: FocusOptions): void;
    blur(): void;
    sendCtrlAltDel(): void;
    clipboardPasteFrom(text: string): void;
  }
}
