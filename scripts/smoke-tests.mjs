import fs from 'fs';
import path from 'path';
import assert from 'assert';

const root = process.cwd();

function read(filePath) {
  return fs.readFileSync(path.join(root, filePath), 'utf8');
}

function listFilesRecursively(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursively(full));
      continue;
    }
    out.push(full);
  }
  return out;
}

function collectRegisteredCommands() {
  const srcRoot = path.join(root, 'src');
  const files = listFilesRecursively(srcRoot).filter((file) => file.endsWith('.ts'));
  const registered = new Set();

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const matches = [...text.matchAll(/registerCommand\('([^']+)'/g)];
    for (const m of matches) {
      registered.add(m[1]);
    }
  }

  return registered;
}

function collectDeclaredCommands() {
  const pkg = JSON.parse(read('package.json'));
  return new Set(pkg.contributes.commands.map((item) => item.command));
}

async function verifyPublicMasking() {
  const guardModulePath = path.join(root, 'out', 'sensitiveDataGuard.js');
  assert.ok(fs.existsSync(guardModulePath), 'Missing compiled sensitiveDataGuard.js in out/.');

  const { sensitiveDataGuard } = await import(`file://${guardModulePath.replace(/\\/g, '/')}`);
  assert.ok(sensitiveDataGuard, 'sensitiveDataGuard export is missing.');

  const ghTokenSample = `ghp_${'123456789012345678901234567890123456'}`;
  const openAiTokenSample = `sk-${'this_is_a_test_key_1234567890'}`;
  const sample = {
    editor: { fontSize: 14 },
    authToken: 'plain-token-value',
    sessionCookie: 'cookie-value',
    nested: {
      Authorization: 'Bearer abc',
      connection: 'postgres://dbuser:dbpass@localhost:5432/app',
      github: ghTokenSample,
      openai: openAiTokenSample
    }
  };

  const { result } = sensitiveDataGuard.redactJsonString(JSON.stringify(sample), 'public');
  const parsed = JSON.parse(result);
  const flattened = JSON.stringify(parsed);

  assert.ok(!('authToken' in parsed), 'public masking should remove authToken key.');
  assert.ok(!('sessionCookie' in parsed), 'public masking should remove sessionCookie key.');
  assert.ok(!('Authorization' in (parsed.nested || {})), 'public masking should remove Authorization key.');
  assert.ok(!flattened.includes(ghTokenSample), 'public masking leaked GitHub token pattern.');
  assert.ok(!flattened.includes(openAiTokenSample), 'public masking leaked OpenAI key pattern.');
  assert.ok(!flattened.includes('postgres://dbuser:dbpass@'), 'public masking leaked DB credentials.');
  assert.ok(flattened.includes('[REDACTED]'), 'public masking should include redacted placeholders.');
}

function main() {
  const declared = collectDeclaredCommands();
  const registered = collectRegisteredCommands();

  const missing = [...declared].filter((cmd) => !registered.has(cmd));
  assert.deepStrictEqual(
    missing,
    [],
    `Declared commands are not registered: ${missing.join(', ')}`
  );

  const bannedTokens = [
    { file: 'src/marketplaceChecker.ts', token: 'normalizeIds(' },
    { file: 'src/settingsManager.ts', token: 'this.parseJsonc(' }
  ];

  for (const { file, token } of bannedTokens) {
    const text = read(file);
    assert.ok(!text.includes(token), `Unexpected token found in ${file}: ${token}`);
  }

  const gistCommandsText = read('src/commands/gistCommands.ts');
  assert.ok(
    gistCommandsText.includes("redactJsonString(rawSettings, 'public')"),
    "shareSettings must redact with 'public' level before creating public gist."
  );

  console.log('Smoke tests passed.');
}

await verifyPublicMasking();
main();
