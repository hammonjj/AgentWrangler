import { describe, expect, it } from 'vitest';
import { MASK, redactForDisplay, wasRedacted } from '../src/remote/redact';

const r = (s: string, opts = {}) => redactForDisplay(s, opts);

describe('redactForDisplay', () => {
  describe('masks what is unmistakably a secret', () => {
    const cases: [string, string][] = [
      ['assignment', 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345 npm publish'],
      ['lowercase assignment', 'api_key=abcdef123456 ./deploy.sh'],
      ['hyphenated name', 'DB-PASSWORD=hunter2 psql'],
      ['quoted value', 'export MY_SECRET="a b c" && run'],
      ['single-quoted value', "export MY_SECRET='a b c' && run"],
      ['colon form', 'client_secret: abcdef123456'],
      ['bearer header', 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc" https://api.example.com'],
      ['bare bearer', 'curl -H "Bearer eyJhbGciOiJIUzI1NiJ9abc" https://x'],
      ['openai key', 'curl -H "x: sk-proj-abcdefghijklmnopqrstuvwxyz" https://x'],
      ['github pat', 'git remote add o https://github_pat_11ABCDEFG0abcdefghijklmnop@github.com/x/y'],
      ['slack token', 'curl -d token=xoxb-123456789012-abcdefgh https://slack.com/api/x'],
      ['aws key id', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE aws s3 ls'],
      ['flag with equals', 'mysql --password=hunter2 -e "select 1"'],
      ['flag with space', 'curl --token abcdef123456 https://x'],
      ['api-key flag', 'tool --api-key abcdef123456'],
      ['url credentials', 'git clone https://jim:s3cr3t@example.com/repo.git'],
    ];

    for (const [name, input] of cases) {
      it(name, () => {
        const out = r(input);
        expect(out).toContain(MASK);
        expect(wasRedacted(input, out)).toBe(true);
      });
    }

    it('masks a whole PEM block', () => {
      const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\nlines\n-----END RSA PRIVATE KEY-----';
      const out = r(`echo "${pem}" > key.pem`);
      expect(out).not.toContain('MIIEow');
      expect(out).toContain(MASK);
    });

    it('keeps the name so the reader still knows what was set', () => {
      expect(r('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345')).toBe(`GITHUB_TOKEN=${MASK}`);
    });

    it('masks every occurrence, not just the first', () => {
      const out = r('A_TOKEN=aaaaaaaaaaaa B_SECRET=bbbbbbbbbbbb');
      expect(out.match(new RegExp(MASK, 'g'))).toHaveLength(2);
    });
  });

  describe('leaves ordinary commands alone', () => {
    // The card exists so a human can decide. Mangling the command is not a
    // safe default — it is a worse decision.
    const untouched = [
      'npm test',
      'git push origin feature/example',
      'mkdir -p build/out',
      'git log -p --oneline -5',
      'grep -rn "token" src/',
      'rm -rf node_modules && npm ci',
      'docker run -p 8080:80 nginx',
      'python3 -c "print(1)"',
      'curl https://api.example.com/v1/things',
      'ls -la ~/Documents',
      'npm run build -- --mode=production',
      'echo "the password prompt appears here"',
      'sed -i "" "s/authors/AUTHORS/" file.txt',
      'TOKENIZER_PATH=/opt/models ./run.sh',
    ];

    for (const cmd of untouched) {
      it(cmd, () => expect(r(cmd)).toBe(cmd));
    }
  });

  describe('home directory', () => {
    it('folds to ~ when a home is supplied', () => {
      expect(r('cat /Users/test/proj/file.ts', { home: '/Users/test' })).toBe('cat ~/proj/file.ts');
    });

    it('folds every occurrence', () => {
      expect(r('diff /Users/test/a /Users/test/b', { home: '/Users/test' })).toBe('diff ~/a ~/b');
    });

    it('tolerates a trailing slash on the home path', () => {
      expect(r('cat /Users/test/x', { home: '/Users/test/' })).toBe('cat ~/x');
    });

    it('leaves paths alone when no home is supplied', () => {
      expect(r('cat /Users/test/x')).toBe('cat /Users/test/x');
    });

    it('does not treat "/" as a home to fold', () => {
      expect(r('cat /etc/hosts', { home: '/' })).toBe('cat /etc/hosts');
    });
  });

  describe('truncation', () => {
    it('caps the result and marks the cut', () => {
      const out = r('x'.repeat(100), { max: 20 });
      expect(out).toHaveLength(20);
      expect(out.endsWith('…')).toBe(true);
    });

    it('leaves a short string untouched', () => {
      expect(r('short', { max: 20 })).toBe('short');
    });

    it('masks before truncating, so a secret cannot survive past the cut', () => {
      // If truncation ran first the token would be gone from view but present
      // in the string we had already decided to send.
      const input = `${'a'.repeat(40)} TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345`;
      const out = r(input, { max: 200 });
      expect(out).not.toContain('ghp_');
      expect(out).toContain(MASK);
    });
  });

  describe('wasRedacted', () => {
    it('is false when nothing changed', () => {
      expect(wasRedacted('npm test', r('npm test'))).toBe(false);
    });

    it('does not claim a redaction when the text already contained the mask', () => {
      const input = `literally ${MASK} typed by the model`;
      expect(wasRedacted(input, r(input))).toBe(false);
    });
  });

  it('handles an empty string', () => {
    expect(r('')).toBe('');
  });
});
