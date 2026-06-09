/**
 * Approval-URL output helper.
 *
 * Prints the human-readable instruction + the raw URL (always, so it stays
 * copy-pastable and usable in piped/non-interactive output), plus a scannable
 * QR code of the URL when stdout is an interactive terminal.
 */
import qrcode from 'qrcode-terminal';

/**
 * Print an approval prompt: a message, the URL, and — on a TTY — a QR code the
 * owner can scan with their phone to open the URL.
 */
export function printApprovalUrl(message: string, url: string): void {
  console.log(`${message}\n  ${url}`);
  // Only render the QR in an interactive terminal. When stdout is piped or
  // redirected (logs, CI, `newio … | cat`) a block-character QR is just noise,
  // and the raw URL above is what a script would consume.
  if (process.stdout.isTTY) {
    console.log('\nOr scan this QR code:\n');
    // `generate` invokes the callback synchronously, so ordering is preserved.
    qrcode.generate(url, { small: true }, (qr) => console.log(qr));
  }
}
