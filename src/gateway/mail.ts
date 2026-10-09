// Outgoing email: sign-up links, password resets, change notices and
// invites, sent through Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email).
// Without RESEND_API_KEY outside production, the console mailer prints each
// message instead, so `bun run dev:hosted` works with no account.

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export function resendMailer(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): Mailer {
  return {
    async send(mail) {
      const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text }),
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        throw new Error(`Resend refused the email: HTTP ${res.status} ${detail}`);
      }
    },
  };
}

export function consoleMailer(): Mailer {
  return {
    async send(mail) {
      console.log(`\n--- email to ${mail.to}: ${mail.subject}\n${mail.text}\n---\n`);
    },
  };
}

const SIGNATURE = "\n\n— SpecDriven";

export const templates = {
  setPassword(link: string): Omit<Mail, "to"> {
    return {
      subject: "Finish setting up your SpecDriven account",
      text:
        `Someone (hopefully you) asked to create a SpecDriven account with this email address.\n\n` +
        `Choose your password here — the link works once and expires in 24 hours:\n${link}\n\n` +
        `If this wasn't you, ignore this email; no account is created.` +
        SIGNATURE,
    };
  },
  reset(link: string): Omit<Mail, "to"> {
    return {
      subject: "Reset your SpecDriven password",
      text:
        `Someone (hopefully you) asked to reset the password of your SpecDriven account.\n\n` +
        `Choose a new password here — the link works once and expires in 30 minutes:\n${link}\n\n` +
        `If this wasn't you, ignore this email; your password stays as it is.` +
        SIGNATURE,
    };
  },
  passwordChanged(): Omit<Mail, "to"> {
    return {
      subject: "Your SpecDriven password was changed",
      text:
        `The password of your SpecDriven account was just changed, and every other sign-in was ended.\n\n` +
        `If this wasn't you, reset your password right away from the sign-in page.` +
        SIGNATURE,
    };
  },
  invite(link: string, inviter: string): Omit<Mail, "to"> {
    return {
      subject: "You're invited to SpecDriven",
      text: `${inviter} invited you to SpecDriven. Sign up with this email address here:\n${link}` + SIGNATURE,
    };
  },
};
