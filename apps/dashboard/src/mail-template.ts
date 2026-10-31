/**
 * Email clients disagree about stylesheets and fonts, so the layout is a
 * presentation table with inline styles and a system-font stack; nothing
 * depends on an image, a downloaded font or external CSS.
 */

// Mail is delivered by server packages that do not load the React interface.
const MARK = `<svg aria-hidden="true" data-agentify-mark="standard" fill="none" focusable="false" height="30" viewBox="0 0 128 128" width="30" xmlns="http://www.w3.org/2000/svg">
  <rect fill="#0F736E" height="128" rx="30" width="128" />
  <path d="M50 40 H40 A6 6 0 0 0 34 46 V82 A6 6 0 0 0 40 88 H50" fill="none" stroke="#F6F4EF" stroke-linecap="round" stroke-width="7" />
  <path d="M78 40 H88 A6 6 0 0 1 94 46 V82 A6 6 0 0 1 88 88 H78" fill="none" stroke="#F6F4EF" stroke-linecap="round" stroke-width="7" />
  <circle cx="64" cy="64" fill="#F6F4EF" r="10" />
</svg>`;

export interface TransactionalEmail {
  readonly preview: string;
  readonly eyebrow?: string;
  readonly title: string;
  readonly lead: string;
  readonly action: string;
  readonly link: string;
  readonly paragraphs: readonly string[];
  /** Why this address was sent the message; the sign-in's reason where absent. */
  readonly reason?: string;
}

/** Escape untrusted text before placing it in HTML text or an attribute. */
const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );

export function transactionalEmailHtml(
  message: TransactionalEmail,
  options: { readonly paragraphsBeforeAction?: boolean } = {},
): string {
  const preview = escapeHtml(message.preview);
  const eyebrow = message.eyebrow === undefined ? "" : escapeHtml(message.eyebrow);
  const title = escapeHtml(message.title);
  const lead = escapeHtml(message.lead);
  const action = escapeHtml(message.action);
  const link = escapeHtml(message.link);
  const reason = escapeHtml(
    message.reason ?? "This message was sent because this address was entered at Agentify.",
  );
  const paragraphs = message.paragraphs
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px;color:#6B6862;font-size:15px;line-height:1.65;white-space:pre-wrap;">${escapeHtml(paragraph)}</p>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    @media (max-width: 480px) {
      .mail-outer { padding:24px 12px !important; }
      .mail-card { padding:24px 16px !important; }
      .mail-title { font-size:24px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#F6F4EF;color:#1A1917;font-family:'Schibsted Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preview}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#F6F4EF;">
    <tr>
      <td class="mail-outer" align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;">
          <tr>
            <td style="padding:0 4px 24px;color:#1A1917;font-size:20px;font-weight:600;letter-spacing:-0.4px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
                <td style="width:30px;height:30px;vertical-align:middle;">${MARK}</td>
                <td style="padding-left:10px;vertical-align:middle;">Agentify</td>
              </tr></table>
            </td>
          </tr>
          <tr>
            <td class="mail-card" style="background:#FFFEFA;border:1px solid #E7E3DB;border-radius:14px;padding:32px 24px;">
              ${eyebrow === "" ? "" : `<p style="margin:0 0 12px;color:#0F736E;font-size:12px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;">${eyebrow}</p>`}
              <h1 class="mail-title" style="margin:0 0 16px;color:#1A1917;font-size:30px;line-height:1.2;font-weight:650;letter-spacing:-0.7px;">${title}</h1>
              <p style="margin:0 0 28px;color:#1A1917;font-size:17px;line-height:1.6;">${lead}</p>
              ${options.paragraphsBeforeAction ? `${paragraphs}\n              ` : ""}<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;">
                <tr>
                  <td style="background:#0F736E;border-radius:12px;">
                    <a href="${link}" style="display:inline-block;padding:14px 22px;color:#FFFFFF;font-size:15px;font-weight:700;line-height:20px;text-decoration:none;">${action}</a>
                  </td>
                </tr>
              </table>
              ${options.paragraphsBeforeAction ? "" : paragraphs}
              <p style="margin:24px 0 8px;color:#6B6862;font-size:13px;line-height:1.55;">If the button does not work, copy this link into your browser:</p>
              <p style="margin:0;padding:12px 14px;background:#F6F4EF;border:1px solid #E7E3DB;border-radius:8px;color:#0F736E;font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;font-size:12px;line-height:1.55;overflow-wrap:anywhere;word-break:normal;"><a href="${link}" style="color:#0F736E;text-decoration:underline;overflow-wrap:anywhere;word-break:normal;">${link}</a></p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 4px 0;color:#6B6862;font-size:12px;line-height:1.5;">${reason}</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
