// Static checks on the site as it ships: `bun test website/test` (CI's website lane).
//
// Nothing here renders a page. The things worth a test are the ones that fail silently in
// production: an association file that stops parsing (App Links then open the browser with no
// error anywhere), a page that starts loading something from another origin (the site promises
// /pair leaks nothing), and the installer script and the download buttons drifting apart.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const site = join(import.meta.dir, '..', 'site');
const read = (path: string) => readFileSync(join(site, path), 'utf8');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [relative(site, path).split(sep).join('/')];
  });
}

const files = walk(site);
const pages = files.filter((f) => f.endsWith('.html'));

describe('association files', () => {
  test('assetlinks.json names the app and one well-formed fingerprint per entry', () => {
    const statements = JSON.parse(read('.well-known/assetlinks.json'));
    expect(statements).toHaveLength(1);
    const target = statements[0].target;
    expect(target.package_name).toBe('com.unrealjune.streetcryptid');
    expect(target.sha256_cert_fingerprints.length).toBeGreaterThan(0);
    for (const fp of target.sha256_cert_fingerprints) {
      // One malformed entry can get the whole statement rejected, the valid one with it.
      expect(fp).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    }
  });

  test('apple-app-site-association claims /pair and /repeater for the app', () => {
    const aasa = JSON.parse(read('.well-known/apple-app-site-association'));
    const [details] = aasa.applinks.details;
    expect(details.appIDs).toEqual(['X37464B5A7.com.unrealjune.streetcryptid']);
    const paths = details.components.map((c: { '/': string }) => c['/']);
    for (const path of ['/pair', '/pair/', '/repeater/claim']) {
      expect(paths).toContain(path);
    }
    // The setup guide has to open in a browser on a phone that has the app.
    expect(paths).not.toContain('/repeater');
    expect(paths).not.toContain('/repeater/');
  });
});

describe('pages', () => {
  test.each(pages)('%s loads nothing from another origin', (page) => {
    const html = read(page);
    // Navigation to GitHub is fine; fetching anything (script, style, font, image) is not.
    const loads = [
      ...html.matchAll(/<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)="([^"]+)"/g),
    ].map((m) => m[1]);
    for (const url of loads) {
      expect(url.startsWith('/')).toBe(true);
    }
    expect(read('style.css')).not.toMatch(/url\(\s*["']?https?:/);
  });

  test.each(pages)('%s references only files that exist', (page) => {
    const html = read(page);
    for (const [, url] of html.matchAll(/\b(?:src|href)="(\/[^"#?]*)"/g)) {
      if (['/', '/pair', '/repeater', '/repeater/claim'].includes(url)) continue;
      expect(existsSync(join(site, url))).toBe(true);
    }
  });
});

describe('repeater installer', () => {
  const script = read('repeater/install.ps1');
  const guide = read('repeater/index.html');

  test('the script and the download buttons fetch the same release assets', () => {
    const base = 'https://github.com/unrealJune/streetCryptid/releases/download/repeater-preview/';
    expect(script).toContain(`"${base}$name"`);
    expect(script).toContain('"StreetCryptid.Repeater-repeater-$rid-Setup.exe"');
    for (const rid of ['win-x64', 'win-arm64']) {
      expect(script).toContain(`'${rid}'`);
      expect(guide).toContain(`${base}StreetCryptid.Repeater-repeater-${rid}-Setup.exe`);
    }
  });

  test('the script keeps SmartScreen in the loop', () => {
    // An unsigned installer fetched by a script has no Mark of the Web, so Windows would run it
    // without the warning. The script writes the mark and refuses to start the file without it.
    expect(script).toMatch(/-Stream Zone\.Identifier/);
    expect(script).toContain('ZoneId=3');
    const mark = script.indexOf('Zone.Identifier');
    const start = script.lastIndexOf('Start-Process -FilePath $dest');
    expect(mark).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(mark);
  });

  test('the commands on the page run the script this site serves', () => {
    expect(guide).toContain('irm https://streetcrypt.id/repeater/install.ps1 | iex');
    expect(files).toContain('repeater/install.ps1');
  });

  test('the Linux tab points at the Linux releases and the commands the binary takes', () => {
    const start = guide.indexOf('id="os-linux"');
    expect(start).toBeGreaterThan(0);
    const linux = guide.slice(start, guide.indexOf('</section>', start));
    // Versioned file names on prereleases: no stable asset URL exists to link to instead.
    expect(linux).toContain(
      'https://github.com/unrealJune/streetCryptid/releases?q=linux-v&amp;expanded=true'
    );
    // package.sh names each tarball streetcryptid-repeater-<version>-<arch>-linux.tar.gz.
    expect(linux).toContain('streetcryptid-repeater-*-$(uname -m)-linux.tar.gz');
    for (const command of [
      './streetcryptid-repeater run',
      'sudo ./streetcryptid-repeater install --system',
      'streetcryptid-repeater settings',
      'SHA256SUMS',
    ]) {
      expect(linux).toContain(command);
    }
  });

  test('the script is ASCII, so Windows PowerShell 5.1 reads it the same as pwsh', () => {
    expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(script)).toBe(true);
  });

  test('the Mac guide uses its own release channel and explains the login-session lifetime', () => {
    const start = guide.indexOf('id="os-macos"');
    const mac = guide.slice(start, guide.indexOf('id="os-linux"', start));
    expect(mac).toContain('releases?q=macos-v&amp;expanded=true');
    expect(mac).toContain('streetcryptid-repeater-*-universal-macos.zip');
    expect(mac).toContain('not after logout or before login');
    expect(mac).toContain('Do not disable Gatekeeper');
    expect(mac).not.toContain('releases/latest');
  });
});
