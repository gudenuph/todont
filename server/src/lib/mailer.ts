import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { boardSettings } from './board.js';

/**
 * Outbound mail, over whatever SMTP the instance has.
 *
 * Volume here is a handful of messages a day at most — a verification when
 * somebody signs up — so this is one plain SMTP connection rather than a
 * queue, a worker or a delivery service. A Gmail account with an app password
 * is a perfectly good backend for that, and costs nothing to run.
 *
 * Mail is **optional**. With no SMTP configured the tracker works exactly as it
 * did before; verification links are written to the log instead, so a
 * self-hoster with no mail server at all can still finish a signup by copying
 * one out of `docker logs`.
 */

let transporter: Transporter | null = null;
let warned = false;

export function mailEnabled(): boolean {
  return config.smtp.host !== '' && config.smtp.from !== '';
}

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      // Port 465 is implicit TLS; 587 starts plain and upgrades with STARTTLS.
      secure: config.smtp.secure ?? config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      ...(config.smtp.allowInsecureTls ? { tls: { rejectUnauthorized: false } } : {}),
    });
  }
  return transporter;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Send, and never throw.
 *
 * Nothing here is important enough to fail the thing that triggered it: a
 * signup must not collapse because a mail server is having a bad morning. The
 * caller gets a boolean and the reason goes to the log.
 */
export async function sendMail(
  mail: Mail,
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void },
): Promise<boolean> {
  if (!mailEnabled()) {
    if (!warned) {
      warned = true;
      log.warn({}, 'SMTP is not configured — mail is being logged instead of sent');
    }
    log.info({ to: mail.to, subject: mail.subject, body: mail.text }, 'mail (not sent)');
    return false;
  }

  try {
    await getTransporter().sendMail({
      from: config.smtp.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
    });
    log.info({ to: mail.to, subject: mail.subject }, 'mail sent');
    return true;
  } catch (err) {
    // The link is logged too, so a failed send is recoverable by hand rather
    // than leaving somebody with no way to finish signing up.
    log.warn({ err, to: mail.to, body: mail.text }, 'mail failed to send');
    return false;
  }
}

export function verificationMail(to: string, name: string, link: string): Mail {
  const board = boardSettings().name;
  return {
    to,
    subject: `Confirm your email for ${board}`,
    text: [
      `Hello ${name},`,
      '',
      `Someone — hopefully you — signed up to ${board} with this address.`,
      'Open this link to confirm it:',
      '',
      link,
      '',
      'The link works once and expires in 24 hours.',
      '',
      'If it was not you, ignore this. Nothing was created in your name that',
      'anyone can use without the link.',
    ].join('\n'),
  };
}
