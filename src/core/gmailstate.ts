/**
 * Gmail data and the three edits the tab can make.
 *
 * Nothing here sends mail. Archive and mark-read are confirmed on cards before
 * they run, and a reply is only ever a draft created in Gmail.
 */

import { invoke } from './bridge';
import { refresh } from '../island/host';

export interface Mail {
  id: string;
  thread_id: string;
  from: string;
  subject: string;
  snippet: string;
  date: number;
  unread: boolean;
}

export interface Inbox {
  email: string;
  unread: number;
  messages: Mail[];
}

export interface GmailStatus {
  configured: boolean;
  connected: boolean;
  accounts: string[];
}

type PendingKind = 'archive' | 'read';

interface Pending {
  kind: PendingKind;
  id: string;
  subject: string;
}

interface Composer {
  id: string;
  subject: string;
  from: string;
}

interface State {
  status: GmailStatus | null;
  /** Which connected address the tab is showing. */
  account: string | null;
  inbox: Inbox | null;
  loading: boolean;
  connecting: boolean;
  error: string | null;
  notice: string | null;
  pending: Pending | null;
  composer: Composer | null;
  /** Kept here so a redraw does not throw away a half-written reply. */
  draftText: string;
  drafting: boolean;
  at: number;
}

export const gmail: State = {
  status: null,
  account: null,
  inbox: null,
  loading: false,
  connecting: false,
  error: null,
  notice: null,
  pending: null,
  composer: null,
  draftText: '',
  drafting: false,
  at: 0,
};

export function mailSubtitle(): string {
  if (!gmail.status) return 'checking…';
  if (!gmail.status.configured) return 'Google client needed';
  if (!gmail.status.connected) return 'not connected';
  if (!gmail.inbox) return gmail.loading ? 'reading your inbox…' : 'inbox';
  return gmail.inbox.unread
    ? `${gmail.inbox.unread} unread`
    : 'inbox clear';
}

export async function loadGmail(force = false) {
  // The inbox is not as urgent as a pull request; a minute is close enough.
  if (!force && gmail.inbox && Date.now() - gmail.at < 60_000) return;

  gmail.loading = true;
  gmail.error = null;
  refresh();
  try {
    gmail.status = await invoke<GmailStatus>('gmail_status');
    const accounts = gmail.status?.accounts ?? [];
    if (gmail.account && !accounts.includes(gmail.account)) gmail.account = null;
    if (!gmail.account) gmail.account = accounts[0] ?? null;
    if (gmail.status?.connected && gmail.account) {
      gmail.inbox = await invoke<Inbox>('gmail_inbox', { account: gmail.account });
      gmail.at = Date.now();
    } else {
      gmail.inbox = null;
    }
  } catch (e) {
    gmail.error = String(e);
  } finally {
    gmail.loading = false;
    refresh();
  }
}

export async function connectGmail() {
  gmail.connecting = true;
  gmail.error = null;
  gmail.notice = null;
  refresh();
  try {
    gmail.account = await invoke<string>('gmail_connect');
    gmail.notice = 'Connected.';
    await loadGmail(true);
  } catch (e) {
    gmail.error = String(e);
  } finally {
    gmail.connecting = false;
    refresh();
  }
}

/** Switches the tab to another connected address and reads its inbox. */
export async function selectAccount(email: string) {
  if (email === gmail.account) return;
  gmail.account = email;
  gmail.inbox = null;
  gmail.pending = null;
  gmail.composer = null;
  gmail.error = null;
  gmail.notice = null;
  gmail.at = 0;
  await loadGmail(true);
}

export async function disconnectGmail() {
  if (!gmail.account) return;
  gmail.error = null;
  gmail.notice = null;
  try {
    await invoke<void>('gmail_disconnect', { account: gmail.account });
    gmail.account = null;
    gmail.inbox = null;
    gmail.pending = null;
    gmail.composer = null;
    gmail.at = 0;
    gmail.notice = 'Disconnected.';
    await loadGmail(true);
  } catch (e) {
    gmail.error = String(e);
  }
  refresh();
}

export function askArchive(mail: Mail) {
  gmail.pending = { kind: 'archive', id: mail.id, subject: mail.subject };
  gmail.notice = null;
  refresh();
}

export function askRead(mail: Mail) {
  gmail.pending = { kind: 'read', id: mail.id, subject: mail.subject };
  gmail.notice = null;
  refresh();
}

export function cancelPending() {
  gmail.pending = null;
  refresh();
}

export async function confirmPending() {
  const pending = gmail.pending;
  if (!pending || !gmail.account) return;

  gmail.pending = null;
  gmail.error = null;
  gmail.notice = null;
  gmail.loading = true;
  refresh();
  try {
    await invoke<void>(
      pending.kind === 'archive' ? 'gmail_archive' : 'gmail_mark_read',
      { account: gmail.account, id: pending.id },
    );
    gmail.notice = pending.kind === 'archive' ? 'Archived.' : 'Marked read.';
    await loadGmail(true);
  } catch (e) {
    gmail.error = String(e);
  } finally {
    gmail.loading = false;
    refresh();
  }
}

export function composeReply(mail: Mail) {
  gmail.composer = { id: mail.id, subject: mail.subject, from: mail.from };
  gmail.draftText = '';
  gmail.pending = null;
  gmail.error = null;
  gmail.notice = null;
  refresh();
}

export function cancelComposer() {
  gmail.composer = null;
  gmail.draftText = '';
  refresh();
}

export async function createDraft(text: string) {
  const composer = gmail.composer;
  if (!composer || !gmail.account) return;
  gmail.draftText = text;
  if (!text.trim()) {
    gmail.error = 'Write something first.';
    refresh();
    return;
  }

  gmail.drafting = true;
  gmail.error = null;
  gmail.notice = null;
  refresh();
  try {
    await invoke<void>('gmail_draft', { account: gmail.account, id: composer.id, body: text });
    gmail.composer = null;
    gmail.draftText = '';
    gmail.notice = 'Draft created in Gmail. Open Gmail to send it.';
  } catch (e) {
    gmail.error = String(e);
  } finally {
    gmail.drafting = false;
    refresh();
  }
}
