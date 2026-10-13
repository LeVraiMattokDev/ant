/**
 * RPC contract of the `computer` service (the agents' isolated machine).
 * All endpoints require `Authorization: Bearer <COMPUTER_RPC_TOKEN>`.
 */
import type { BrowserAction } from './risk';

export const WORKSPACE_ROOT = '/workspace';

export interface ExecRequest {
  command: string;
  /** Relative to /workspace (default: /workspace). */
  cwd?: string;
  timeoutSec?: number;
}

export interface ExecResponse {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface FileReadRequest {
  path: string;
  /** 1-based line to start from. */
  offset?: number;
  /** Max number of lines. */
  limit?: number;
}

export interface FileReadResponse {
  path: string;
  content: string;
  totalLines: number;
  truncated: boolean;
  binary: boolean;
}

export interface FileWriteRequest {
  path: string;
  content: string;
  append?: boolean;
}

export interface FileEditRequest {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export interface FileListRequest {
  path?: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  modifiedAt: string;
}

export interface BrowserRequest {
  action: BrowserAction;
  url?: string;
  /** Element reference from the last `read` (e.g. "e12"). */
  ref?: string;
  /** CSS selector, alternative to `ref`. */
  selector?: string;
  /**
   * Pin returned by `inspect` (approval cards): targets exactly the node the owner saw, survives
   * later `read`s (which renumber refs). Takes precedence over ref/selector; must match one node.
   */
  pin?: string;
  /** Text to type (type) or option value/label (select). */
  text?: string;
  /** Key for `press` (e.g. "Enter"). */
  key?: string;
  direction?: 'up' | 'down';
  /** Include a PNG screenshot (base64) in the response. */
  screenshot?: boolean;
}

export interface BrowserElement {
  ref: string;
  role: string;
  name: string;
}

export interface BrowserResponse {
  ok: boolean;
  url: string;
  title: string;
  /** Visible text (read). */
  text?: string;
  /** Interactive elements (read). */
  elements?: BrowserElement[];
  screenshotPng?: string;
  error?: string;
}

export interface BrowserTargetInfo {
  url: string;
  title: string;
  /** Accessible name / text of the element targeted by ref/selector, for approval cards. */
  elementLabel: string | null;
  /** Pin of that exact element (see `BrowserRequest.pin`), when it was found. */
  pin?: string;
}

export interface ComputerHealth {
  ok: boolean;
  display: boolean;
  browser: boolean;
  url: string | null;
}
