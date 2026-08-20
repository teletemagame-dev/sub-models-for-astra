/**
 * Turning a CLI's failure into a sentence somebody can act on.
 *
 * A turn that fails because nobody is signed in is not an internal error, and
 * saying "INTERNAL: … at throwIneligibleOrProjectIdError (file:///C:/…)" tells
 * the user nothing except that something went wrong somewhere. These CLIs fail
 * in a small number of knowable ways — never signed in, signed in but stale,
 * bad key, plan limit reached — and each has a different answer.
 *
 * The patterns are deliberately loose, because vendors reword these constantly
 * and a rule that matches one sentence stops matching the moment it is edited.
 * Matching a shape survives that.
 */

export interface Diagnosis {
  /** One sentence, in both languages, replacing the raw failure. */
  message: string;
  /** True when the cause is the account rather than the machine. */
  isAuth: boolean;
}

interface Rule {
  test: RegExp;
  diagnose(label: string): Diagnosis;
}

const RULES: Rule[] = [
  {
    test: /invalid API key|API key not valid|API_KEY_INVALID/i,
    diagnose: (label) => ({
      isAuth: true,
      message:
        `${label} rejected the API key it was given. Check the key in your environment. ` +
        `— По-русски: ${label} отклонил переданный API-ключ. Проверьте ключ в переменных окружения.`,
    }),
  },
  {
    // A session that has gone stale rather than one that was never made. Worth
    // its own rule because the cheap status check does not catch it: `codex
    // login status` answered "Logged in using ChatGPT" for a token that could
    // no longer be refreshed, and only a real turn found out.
    test: /token could not be refreshed|log out and sign in|session (?:has )?expired|refresh(?:ing)? (?:the )?token failed/i,
    diagnose: (label) => ({
      isAuth: true,
      message:
        `${label} is signed in, but its session has gone stale and could not be refreshed. Sign in again: ` +
        `log out and back in from a terminal. Its own status command will keep saying you are logged in ` +
        `until you do. — По-русски: ${label} авторизован, но сессия протухла и обновить её не удалось. ` +
        `Войдите заново: разлогиньтесь и залогиньтесь из терминала. Его собственная проверка статуса ` +
        `до этого момента будет продолжать говорить, что вы вошли.`,
    }),
  },
  {
    test: /authentication required|please sign in|please run \/login|not (?:logged in|authenticated)|Error authenticating/i,
    diagnose: (label) => ({
      isAuth: true,
      message:
        `${label} is installed but nobody is signed in to it, so it refused the turn. Run it with no ` +
        `arguments in a terminal and sign in — it opens a browser against your own account, and this plugin ` +
        `never sees the credentials. — По-русски: ${label} установлен, но вход в него не выполнен, поэтому ` +
        `запрос отклонён. Запустите его в терминале без аргументов и войдите: откроется браузер с вашим ` +
        `аккаунтом, плагин учётных данных не видит.`,
    }),
  },
  {
    test: /rate limit|quota exceeded|usage limit|429/i,
    diagnose: (label) => ({
      isAuth: false,
      message:
        `${label} says the plan's own limit is reached — this is the provider's throttle, not the one in ` +
        `this plugin's settings, and only time or a bigger plan clears it. — По-русски: ${label} сообщает, ` +
        `что достигнут лимит самого плана. Это троттлинг провайдера, а не лимит из настроек плагина: ` +
        `помогает только время или более крупный план.`,
    }),
  },
];

/** A diagnosis for text that matches something known, or null. */
export function diagnose(label: string, text: string): Diagnosis | null {
  for (const rule of RULES) {
    if (rule.test.test(text)) return rule.diagnose(label);
  }
  return null;
}

/**
 * The readable part of a CLI's noise.
 *
 * Stack frames are dropped, and so is the `file:///…` line that usually
 * follows them: a path inside somebody else's bundle is not information the
 * reader can use, and it crowds out the one sentence that is.
 */
export function readable(text: string, maxLines = 3, maxChars = 400): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^at\s|^\s*at\s|^file:\/\/\/|^\s*\.\.\.\s*\d+\s+more/.test(line))
    // A single line can still carry a whole trace, when the CLI joined its
    // frames with pipes rather than newlines.
    .map((line) => line.split(/\s+\|\s+at\s/)[0].split(/\s+at\s+\S+\s+\(file:/)[0]);

  return lines.slice(0, maxLines).join(" ").slice(0, maxChars).trim();
}
