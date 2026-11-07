//! Gmail — OAuth, the inbox, and the three edits Ryfe is allowed to make.
//!
//! Read, archive, mark read, and create a draft. Nothing here sends mail.
//! The scope is `gmail.modify`, the narrowest one that covers those edits; one
//! refresh token per connected account and the Desktop client's id/secret live
//! in the credential store.

use std::time::Duration;

use base64::Engine;
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::timeout;

use crate::secrets;

const AUTH: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN: &str = "https://oauth2.googleapis.com/token";
const API: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const SCOPE: &str = "https://www.googleapis.com/auth/gmail.modify";
const WAIT: Duration = Duration::from_secs(300);
const MAX_DRAFT: usize = 20_000;

#[derive(Serialize)]
pub struct GmailStatus {
    pub configured: bool,
    pub connected: bool,
    /// Every address Ryfe holds a refresh token for, in the order added.
    pub accounts: Vec<String>,
}

#[derive(Serialize)]
pub struct Mail {
    pub id: String,
    pub thread_id: String,
    pub from: String,
    pub subject: String,
    pub snippet: String,
    pub date: i64,
    pub unread: bool,
}

#[derive(Serialize)]
pub struct Inbox {
    pub email: String,
    pub unread: u64,
    pub messages: Vec<Mail>,
}

#[derive(Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn creds() -> Result<(String, String), String> {
    let id = secrets::get("google-client-id")
        .ok_or_else(|| "Add your Desktop OAuth client ID in Settings → Google.".to_string())?;
    let secret = secrets::get("google-client-secret")
        .ok_or_else(|| "Add your Desktop OAuth client secret in Settings → Google.".to_string())?;
    Ok((id, secret))
}

/// The connected addresses, in the order they were added.
fn accounts() -> Vec<String> {
    secrets::get("google-accounts")
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn remember_account(email: &str) -> Result<(), String> {
    let mut list = accounts();
    if list.iter().any(|a| a == email) {
        return Ok(());
    }
    list.push(email.to_string());
    let raw = serde_json::to_string(&list).map_err(|e| format!("could not save accounts: {e}"))?;
    secrets::set("google-accounts", &raw)
}

fn account_key(email: &str) -> Result<String, String> {
    if !secrets::valid_gmail_account(email) {
        return Err("That does not look like a connected Gmail account.".to_string());
    }
    Ok(format!("google-refresh-token:{email}"))
}

/// A Gmail id goes straight into a URL path; nothing else does.
fn checked_id(id: &str) -> Result<&str, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("That message id does not look like a Gmail id.".to_string());
    }
    Ok(id)
}

/// Escapes a value that came back from Google before it goes in a page or an error.
fn safe(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ' '))
        .take(80)
        .collect()
}

/// One place for the two failures a user can actually fix.
fn gmail_error(status: reqwest::StatusCode) -> String {
    if status == reqwest::StatusCode::FORBIDDEN {
        "Gmail refused the request. Check that the Gmail API is enabled for the Google Cloud project and that gmail.modify was granted."
            .to_string()
    } else if status == reqwest::StatusCode::UNAUTHORIZED {
        "Gmail rejected the sign-in. Reconnect from the Gmail tab.".to_string()
    } else {
        format!("Gmail returned {status}")
    }
}

async fn reply(mut socket: tokio::net::TcpStream, message: &str) {
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Ryfe</title>\
         <body style=\"margin:0;height:100vh;display:grid;place-items:center;\
         background:#07080b;color:#eef1f5;font:15px system-ui\">{message}</body>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

async fn access_token(account: &str) -> Result<String, String> {
    let key = account_key(account)?;
    let refresh = secrets::get(&key).ok_or_else(|| {
        "That Gmail account is not connected. Connect it from the Gmail tab.".to_string()
    })?;
    let (id, secret) = creds()?;

    let res = client()?
        .post(TOKEN)
        .form(&[
            ("client_id", id.as_str()),
            ("client_secret", secret.as_str()),
            ("refresh_token", refresh.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| format!("could not reach Google: {e}"))?;

    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("could not read Google's reply: {e}"))?;

    if !status.is_success() {
        if text.contains("invalid_grant") {
            return Err(
                "Gmail sign-in expired or was revoked. Reconnect from the Gmail tab.".to_string(),
            );
        }
        return Err(format!("Google refused the sign-in ({status})"));
    }

    let tokens: Tokens =
        serde_json::from_str(&text).map_err(|e| format!("Google sent something odd: {e}"))?;
    Ok(tokens.access_token)
}

async fn wait_for_code(listener: TcpListener, state: &str) -> Result<String, String> {
    timeout(WAIT, async move {
        loop {
            let (mut socket, _) = listener
                .accept()
                .await
                .map_err(|e| format!("sign-in listener: {e}"))?;

            let mut buf = vec![0u8; 8192];
            let n = socket
                .read(&mut buf)
                .await
                .map_err(|e| format!("sign-in listener: {e}"))?;
            let request = String::from_utf8_lossy(&buf[..n]);
            let path = request
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("/");

            let parsed = reqwest::Url::parse(&format!("http://127.0.0.1{path}")).ok();
            let mut code = None;
            let mut got_state = None;
            let mut error = None;
            if let Some(url) = parsed {
                for (k, v) in url.query_pairs() {
                    match k.as_ref() {
                        "code" => code = Some(v.into_owned()),
                        "state" => got_state = Some(v.into_owned()),
                        "error" => error = Some(v.into_owned()),
                        _ => {}
                    }
                }
            }

            if let Some(err) = error {
                let message = format!("Google declined the sign-in: {}", safe(&err));
                reply(socket, &message).await;
                return Err(message);
            }

            if let Some(code) = code {
                if got_state.as_deref() != Some(state) {
                    let message = "The sign-in did not come back from Ryfe's own request. Try again.";
                    reply(socket, message).await;
                    return Err(message.to_string());
                }
                reply(socket, "Ryfe is connected. You can close this tab.").await;
                return Ok(code);
            }

            // A browser asking for the favicon, or anything else without a code.
            reply(socket, "Ryfe is waiting for Google.").await;
        }
    })
    .await
    .map_err(|_| "Timed out waiting for Google. Try again.".to_string())?
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn gmail_status() -> GmailStatus {
    let accounts = accounts();
    GmailStatus {
        configured: secrets::present("google-client-id")
            && secrets::present("google-client-secret"),
        connected: !accounts.is_empty(),
        accounts,
    }
}

#[tauri::command]
pub async fn gmail_connect() -> Result<String, String> {
    let (client_id, client_secret) = creds()?;

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("could not open the local sign-in listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("could not read the listener address: {e}"))?
        .port();
    let redirect = format!("http://127.0.0.1:{port}");

    let verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = b64url(digest.as_slice());
    let state = uuid::Uuid::new_v4().simple().to_string();

    let mut url = reqwest::Url::parse(AUTH).map_err(|e| format!("auth url: {e}"))?;
    url.query_pairs_mut()
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPE)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent select_account")
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");

    crate::platform::open_url(url.to_string())?;
    let code = wait_for_code(listener, &state).await?;

    let res = client()?
        .post(TOKEN)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|e| format!("could not reach Google: {e}"))?;

    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("could not read Google's reply: {e}"))?;
    if !status.is_success() {
        let hint = if text.contains("invalid_client") {
            "Google rejected the client ID or secret."
        } else if text.contains("redirect_uri_mismatch") {
            "The client is not a Desktop app, or its redirect URI does not allow loopback."
        } else {
            "Check the client ID and secret."
        };
        return Err(format!("Google refused the sign-in ({status}): {hint}"));
    }

    let tokens: Tokens =
        serde_json::from_str(&text).map_err(|e| format!("Google sent something odd: {e}"))?;
    let refresh = tokens.refresh_token.ok_or_else(|| {
        "Google did not return a refresh token. Remove Ryfe from your Google account's third-party access, then connect again."
            .to_string()
    })?;

    let profile = get_json(&client()?, "/profile", &tokens.access_token).await?;
    let email = profile["emailAddress"].as_str().unwrap_or("").to_string();
    if !secrets::valid_gmail_account(&email) {
        return Err("Google returned an account address Ryfe cannot store.".to_string());
    }
    secrets::set(&account_key(&email)?, &refresh)?;
    remember_account(&email)?;
    Ok(email)
}

#[tauri::command]
pub fn gmail_disconnect(account: String) -> Result<(), String> {
    secrets::clear(&account_key(&account)?)?;
    let mut list = accounts();
    list.retain(|a| a != &account);
    let raw =
        serde_json::to_string(&list).map_err(|e| format!("could not save accounts: {e}"))?;
    secrets::set("google-accounts", &raw)
}

// ---------------------------------------------------------------------------
// Gmail API
// ---------------------------------------------------------------------------

async fn get_json(
    client: &reqwest::Client,
    path: &str,
    token: &str,
) -> Result<Value, String> {
    let res = client
        .get(format!("{API}{path}"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("could not reach Gmail: {e}"))?;

    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("could not read Gmail's reply: {e}"))?;

    if !status.is_success() {
        return Err(gmail_error(status));
    }

    serde_json::from_str(&text).map_err(|e| format!("Gmail sent something odd: {e}"))
}

async fn fetch_mail(client: &reqwest::Client, id: &str, token: &str) -> Result<Mail, String> {
    let path = format!(
        "/messages/{id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date"
    );
    let msg = get_json(client, &path, token).await?;

    let header = |name: &str| -> String {
        msg["payload"]["headers"]
            .as_array()
            .and_then(|headers| {
                headers.iter().find(|h| {
                    h["name"]
                        .as_str()
                        .map(|n| n.eq_ignore_ascii_case(name))
                        .unwrap_or(false)
                })
            })
            .and_then(|h| h["value"].as_str())
            .unwrap_or("")
            .to_string()
    };

    let unread = msg["labelIds"]
        .as_array()
        .map(|labels| labels.iter().any(|l| l.as_str() == Some("UNREAD")))
        .unwrap_or(false);

    Ok(Mail {
        id: id.to_string(),
        thread_id: msg["threadId"].as_str().unwrap_or(id).to_string(),
        from: header("From"),
        subject: header("Subject"),
        snippet: msg["snippet"].as_str().unwrap_or("").to_string(),
        date: msg["internalDate"]
            .as_str()
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0),
        unread,
    })
}

#[tauri::command]
pub async fn gmail_inbox(account: String) -> Result<Inbox, String> {
    let token = access_token(&account).await?;
    let client = client()?;

    let profile = get_json(&client, "/profile", &token).await?;
    let email = profile["emailAddress"].as_str().unwrap_or("").to_string();

    let label = get_json(&client, "/labels/INBOX", &token).await?;
    let unread = label["messagesUnread"].as_u64().unwrap_or(0);

    let list = get_json(
        &client,
        "/messages?labelIds=INBOX&maxResults=12",
        &token,
    )
    .await?;
    let ids: Vec<String> = list["messages"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|m| m["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let any_ids = !ids.is_empty();

    let fetched = join_all(ids.iter().map(|id| fetch_mail(&client, id, &token))).await;
    let mut messages = Vec::new();
    let mut first_error = None;
    for result in fetched {
        match result {
            Ok(mail) => messages.push(mail),
            Err(e) => {
                if first_error.is_none() {
                    first_error = Some(e);
                }
            }
        }
    }
    if messages.is_empty() && any_ids {
        if let Some(e) = first_error {
            return Err(e);
        }
    }
    messages.sort_by(|a, b| b.date.cmp(&a.date));

    Ok(Inbox {
        email,
        unread,
        messages,
    })
}

async fn modify(account: &str, id: &str, remove: &[&str]) -> Result<(), String> {
    let id = checked_id(id)?;
    let token = access_token(account).await?;
    let res = client()?
        .post(format!("{API}/messages/{id}/modify"))
        .bearer_auth(&token)
        .json(&json!({ "removeLabelIds": remove }))
        .send()
        .await
        .map_err(|e| format!("could not reach Gmail: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        return Err(gmail_error(status));
    }
    Ok(())
}

#[tauri::command]
pub async fn gmail_archive(account: String, id: String) -> Result<(), String> {
    modify(&account, &id, &["INBOX"]).await
}

#[tauri::command]
pub async fn gmail_mark_read(account: String, id: String) -> Result<(), String> {
    modify(&account, &id, &["UNREAD"]).await
}

fn head(s: &str) -> String {
    s.chars()
        .map(|c| if c == '\r' || c == '\n' { ' ' } else { c })
        .take(300)
        .collect::<String>()
        .trim()
        .to_string()
}

/// A subject with non-ASCII characters has to leave as RFC 2047 encoded words.
fn encode_subject(s: &str) -> String {
    if s.is_ascii() {
        return head(s);
    }
    base64::engine::general_purpose::STANDARD
        .encode(s.as_bytes())
        .as_bytes()
        .chunks(60)
        .filter_map(|chunk| std::str::from_utf8(chunk).ok())
        .map(|chunk| format!("=?UTF-8?B?{chunk}?="))
        .collect::<Vec<_>>()
        .join("\r\n ")
}

fn wrap_76(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + s.len() / 76 * 2);
    for (i, c) in s.chars().enumerate() {
        if i > 0 && i % 76 == 0 {
            out.push_str("\r\n");
        }
        out.push(c);
    }
    out
}

#[tauri::command]
pub async fn gmail_draft(account: String, id: String, body: String) -> Result<(), String> {
    let id = checked_id(&id)?;
    if body.trim().is_empty() {
        return Err("Write something first.".to_string());
    }
    if body.len() > MAX_DRAFT {
        return Err("That draft is too long.".to_string());
    }

    let token = access_token(&account).await?;
    let client = client()?;
    let meta = get_json(
        &client,
        &format!(
            "/messages/{id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References"
        ),
        &token,
    )
    .await?;

    let header = |name: &str| -> String {
        meta["payload"]["headers"]
            .as_array()
            .and_then(|headers| {
                headers.iter().find(|h| {
                    h["name"]
                        .as_str()
                        .map(|n| n.eq_ignore_ascii_case(name))
                        .unwrap_or(false)
                })
            })
            .and_then(|h| h["value"].as_str())
            .unwrap_or("")
            .to_string()
    };

    let to = header("From");
    if to.is_empty() {
        return Err("That message has no sender to reply to.".to_string());
    }
    let subject = header("Subject");
    let message_id = header("Message-ID");
    let references = header("References");
    let thread_id = meta["threadId"].as_str().unwrap_or("").to_string();
    let subject = if subject.to_ascii_lowercase().starts_with("re:") {
        subject
    } else {
        format!("Re: {subject}")
    };

    let encoded = wrap_76(&base64::engine::general_purpose::STANDARD.encode(body.as_bytes()));
    let mut mime = String::new();
    mime.push_str(&format!("To: {}\r\n", head(&to)));
    mime.push_str(&format!("Subject: {}\r\n", encode_subject(&subject)));
    if !message_id.is_empty() {
        mime.push_str(&format!("In-Reply-To: {}\r\n", head(&message_id)));
    }
    let refs = if references.is_empty() {
        message_id.clone()
    } else {
        format!("{references} {message_id}")
    };
    if !refs.trim().is_empty() {
        mime.push_str(&format!("References: {}\r\n", head(&refs)));
    }
    mime.push_str(
        "MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n",
    );
    mime.push_str(&encoded);

    let mut message = json!({ "raw": b64url(mime.as_bytes()) });
    if !thread_id.is_empty() {
        message["threadId"] = json!(thread_id);
    }

    let res = client
        .post(format!("{API}/drafts"))
        .bearer_auth(&token)
        .json(&json!({ "message": message }))
        .send()
        .await
        .map_err(|e| format!("could not reach Gmail: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        return Err(gmail_error(status));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_cannot_escape_the_path() {
        assert!(checked_id("18f2a9b").is_ok());
        assert!(checked_id("a-b_c").is_ok());
        assert!(checked_id("../../me").is_err());
        assert!(checked_id("a/b").is_err());
        assert!(checked_id("").is_err());
    }

    #[test]
    fn headers_cannot_inject_lines() {
        assert_eq!(head("Hello\r\nBcc: someone"), "Hello  Bcc: someone");
        assert_eq!(head("  padded  "), "padded");
    }

    #[test]
    fn base64_body_wraps_at_76() {
        let wrapped = wrap_76(&"a".repeat(160));
        let lines: Vec<&str> = wrapped.split("\r\n").collect();
        assert_eq!(lines.len(), 3);
        assert!(lines.iter().all(|line| line.len() <= 76));
    }

    #[test]
    fn non_ascii_subjects_are_encoded() {
        assert_eq!(encode_subject("Hi"), "Hi");
        assert!(encode_subject("Café").starts_with("=?UTF-8?B?"));
    }

    #[test]
    fn pkce_verifier_is_url_safe() {
        assert_eq!(b64url(b"hi"), "aGk");
    }
}
