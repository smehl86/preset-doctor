/**
 * Bambu Studio issue #12068: the system presets folder ends up missing or empty. Every parent
 * would then look missing, so the scan must not run R1, propose a fix, or allow a write.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT, main, type CliDeps } from './cli.js';
import { defaultChoices, FixError, planFixes } from './fix.js';
import { memFs } from './memFs.js';
import { nodeFs } from './node/nodeFs.js';
import { R1_ID } from './rules/r1.js';
import { R4_ID } from './rules/r4.js';
import { scan, SYSTEM_PRESETS_UNUSABLE } from './scan.js';
import {
  fixtureRoot,
  UNUSABLE_SYSTEM_FIXTURE_NAMES,
  type FixtureName,
  type UnusableSystemFixtureName,
} from './testing/fixtures.js';
import { fakeStudio, sidecar, tempFixture } from './testing/studio.js';
import type { ScanResult, SystemPresetsState } from './types.js';

const MESSAGE =
  "Bambu Studio's system presets are missing or empty, so presets can't be checked. Open " +
  'Bambu Studio and let it finish loading or updating, then scan again.';

const EXPECTED_STATE: Record<UnusableSystemFixtureName, SystemPresetsState> = {
  'system-missing': 'missing',
  'system-empty': 'empty',
  'system-no-presets': 'empty',
};

const fixture = (name: FixtureName | UnusableSystemFixtureName) =>
  nodeFs(fixtureRoot(name), { readOnly: true });
const file = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const fixes = (r: ScanResult) => r.findings.filter((f) => f.proposedFix !== undefined);
const r1 = (r: ScanResult) => r.findings.filter((f) => f.ruleId === R1_ID);

describe('scan with unusable system presets', () => {
  it('uses the wording asked for', () => {
    expect(SYSTEM_PRESETS_UNUSABLE).toBe(MESSAGE);
  });

  it.each(UNUSABLE_SYSTEM_FIXTURE_NAMES)(
    '%s: one top-level error, no R1 finding and no fix',
    async (name) => {
      const r = await scan(fixture(name));
      const path = join(fixtureRoot(name), 'system');
      expect(r.systemPresets).toBe(EXPECTED_STATE[name]);
      expect(r.systemPresetsError).toEqual({ message: `${MESSAGE} Looked in: ${path}`, path });

      // Every one of the 12 parents is "missing" here; none may be reported as an orphan.
      expect(r.presets.filter((p) => p.inherits)).toHaveLength(12);
      expect(r1(r)).toEqual([]);
      expect(fixes(r)).toEqual([]);
      expect(defaultChoices(r)).toEqual([]);
      expect(r.presets.filter((p) => p.status === 'hidden')).toEqual([]);

      // R4 doesn't need the system presets, so it still reports the damaged files.
      expect(r.findings.every((f) => f.ruleId === R4_ID)).toBe(true);
      expect(r.findings.map((f) => [file(f.presetPath), f.severity, f.title])).toEqual([
        ['Missing Name.json', 'error', 'Preset has no name'],
        ['Sunlu Wood PLA.json', 'info', 'No sync file (.info)'],
      ]);

      // Nothing is called OK that wasn't checked, and nothing was judged against printers.
      const count = (s: string) => r.presets.filter((p) => p.status === s).length;
      expect([count('broken'), count('info'), count('ok')]).toEqual([1, 11, 3]);
      expect(r.presets.find((p) => p.name === 'Anycubic Petg')?.reason).toMatch(
        /^Parent ".*" could not be checked \(system presets unreadable\)$/,
      );
      expect(r.indexesRead).toEqual({ filament: false, process: false, machine: false });
      expect(r.systemIndexRead).toBe(false);
      expect(r.presets.every((p) => p.compat === undefined)).toBe(true);
    },
  );

  it.each(UNUSABLE_SYSTEM_FIXTURE_NAMES)('%s: planning a fix is refused', async (name) => {
    const fs = fixture(name);
    const r = await scan(fs);
    const choice = { presetPath: 'user/1000000001/filament/Anycubic Petg.json' };
    for (const choices of [[], [{ ...choice, candidateName: 'Generic PETG @BBL X2D' }]]) {
      const refused = planFixes(fs, r, choices);
      await expect(refused).rejects.toBeInstanceOf(FixError);
      await expect(refused).rejects.toThrow(/system presets are missing or empty.*Looked in: /);
    }
  });

  it('tells a corrupt index and a missing preset folder apart from a missing index', async () => {
    const user = [{ name: 'Mine', inherits: 'Generic PLA @BBL X2D', info: sidecar('x') }];
    const system = [{ name: 'Generic PLA @BBL X2D' }];
    const state = async (damage: (fs: ReturnType<typeof fakeStudio>) => Promise<void>) => {
      const fs = fakeStudio(system, user);
      await damage(fs);
      const r = await scan(fs);
      expect(r1(r)).toEqual([]);
      expect(r.presets.map((p) => p.status)).toEqual(['info']);
      return r.systemPresets;
    };
    expect((await scan(fakeStudio(system, user))).systemPresets).toBe('ok');
    expect(await state((fs) => fs.writeText('system/BBL.json', '{ half-written'))).toBe(
      'unreadable',
    );
    expect(await state((fs) => fs.writeText('system/BBL.json', '{}'))).toBe('empty');
    // BBL.json is there, but the presets it lists are not (a half-done update).
    expect(await state((fs) => fs.remove('system/BBL/filament/Generic PLA @BBL X2D.json'))).toBe(
      'empty',
    );
    // Something else is in system/, but not the index.
    const stray = fakeStudio(system, user);
    await stray.remove('system/BBL.json');
    expect((await scan(stray)).systemPresets).toBe('missing');
  });

  it('takes the fix off an R4 rename too, and names the folder it was given', async () => {
    const user = [
      { file: 'On Disk', name: 'In File', inherits: 'Generic PLA @BBL X2D', info: sidecar('x') },
    ];
    const healthy = await scan(fakeStudio([{ name: 'Generic PLA @BBL X2D' }], user));
    expect(fixes(healthy).map((f) => f.proposedFix)).toEqual([
      { kind: 'renamePreset', newName: 'On Disk' },
    ]);

    const r = await scan(fakeStudio([], user), { root: 'C:\\Users\\me\\AppData\\BambuStudio' });
    expect(r.systemPresets).toBe('empty');
    expect(r.findings.map((f) => [f.ruleId, f.title])).toEqual([
      [R4_ID, "Name doesn't match the file name"],
    ]);
    expect(fixes(r)).toEqual([]);
    expect(r.systemPresetsError?.path).toBe('C:\\Users\\me\\AppData\\BambuStudio\\system');
    expect(
      (await scan(fakeStudio([], user), { root: '/home/me/BambuStudio' })).systemPresetsError,
    ).toMatchObject({ path: '/home/me/BambuStudio/system' });
  });

  it('counts a type with no system presets only when a user preset builds on it', async () => {
    const filament = [{ name: 'Generic PLA @BBL X2D' }];
    // No system process presets, and a process preset that names a parent: it would be an orphan.
    const needed = await scan(
      fakeStudio(filament, [
        { name: 'Mine', inherits: 'Generic PLA @BBL X2D' },
        { type: 'process', name: 'My Process', inherits: '0.20mm Standard @BBL X2D' },
      ]),
    );
    expect(needed.systemPresets).toBe('empty');
    expect(r1(needed)).toEqual([]);

    // Only a wizard process preset (no parent): nothing is checked against the empty list.
    const unneeded = await scan(
      fakeStudio(filament, [
        { name: 'Mine', inherits: 'Gone @BBL X2D' },
        { type: 'process', name: 'Wizard', inherits: '', base: true },
      ]),
    );
    expect(unneeded.systemPresets).toBe('ok');
    expect(unneeded.systemPresetsError).toBeUndefined();
    expect(r1(unneeded).map((f) => f.presetName)).toEqual(['Mine']);
  });

  it('says OrcaSlicer in an OrcaSlicer folder', async () => {
    const fs = memFs({
      'OrcaSlicer.conf': '{"app":{}}',
      'user/default/filament/Mine.json': JSON.stringify({ name: 'Mine', inherits: 'Gone' }),
    });
    const r = await scan(fs, { root: 'Orca' });
    expect(r.slicer).toBe('orca');
    expect(r.systemPresets).toBe('missing');
    expect(r.systemPresetsError?.message).toBe(
      "OrcaSlicer's system presets are missing or empty, so presets can't be checked. Open " +
        'OrcaSlicer and let it finish loading or updating, then scan again. Looked in: Orca/system',
    );
    expect(r1(r)).toEqual([]);
  });
});

describe('scan with usable system presets is unchanged', () => {
  it('healthy: ok, no error, and the same result as before', async () => {
    const r = await scan(fixture('healthy'));
    expect(r.systemPresets).toBe('ok');
    expect(r.systemPresetsError).toBeUndefined();
    expect(r.findings).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.presets).toHaveLength(13);
    expect(r.presets.every((p) => p.status === 'ok')).toBe(true);
    expect(r.indexesRead).toEqual({ filament: true, process: true, machine: true });
    expect(r.systemIndexRead).toBe(true);
    expect(r.systemVersion).toBe('02.08.00.06');
  });

  it('broken-r1 and types-bambu: R1 still finds the orphans and proposes fixes', async () => {
    const broken = await scan(fixture('broken-r1'));
    expect(broken.systemPresets).toBe('ok');
    expect(r1(broken)).toHaveLength(22);
    expect(defaultChoices(broken)).toHaveLength(19);
    const types = await scan(fixture('types-bambu'));
    expect(types.systemPresets).toBe('ok');
    expect(r1(types)).toHaveLength(8);
  });
});

describe('preset-doctor CLI with unusable system presets', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function setup(name: FixtureName | UnusableSystemFixtureName) {
    const t = tempFixture(name);
    cleanups.push(t.cleanup);
    const backupsDir = join(t.dir, '..', 'backups');
    const run = async (...argv: string[]) => {
      let out = '';
      let err = '';
      const deps: Partial<CliDeps> = {
        stdout: (s) => (out += s),
        stderr: (s) => (err += s),
        paths: { studioRoot: t.dir, orcaRoot: join(t.dir, 'no-orca'), backupsDir },
        isStudioRunning: async () => false,
        now: () => new Date(2026, 10, 11, 9, 0, 0),
      };
      return { code: await main(argv, deps), out, err };
    };
    return { root: t.dir, backupsDir, run };
  }

  it.each(UNUSABLE_SYSTEM_FIXTURE_NAMES)(
    '%s: scan prints the error and exits non-zero',
    async (name) => {
      const s = setup(name);
      const error = `ERROR: ${MESSAGE} Looked in: ${join(s.root, 'system')}`;
      const r = await s.run('scan');
      expect(r.code).toBe(EXIT.failed);
      // At the top, above the results, and again at the end.
      expect(r.out.split(error)).toHaveLength(3);
      expect(r.out.indexOf(error)).toBeLessThan(r.out.indexOf('Hidden in Studio (0)'));
      // R4's results come under it.
      expect(r.out).toContain('Broken (1)');
      expect(r.out).toContain('Preset has no name');
      expect(r.out).toContain('OK, with notes (11)');
      expect(r.out).toContain('Summary: 0 hidden, 1 broken, 11 OK with notes, 3 OK.');
      expect(r.out).not.toContain('fix:');
      expect(r.out).not.toContain('To preview repairs');

      const json = await s.run('scan', '--json');
      expect(json.code).toBe(EXIT.failed);
      expect(json.err).toBe(`${error}\n`);
      const parsed = JSON.parse(json.out) as ScanResult;
      expect(parsed.systemPresets).toBe(EXPECTED_STATE[name]);
      expect(parsed.systemPresetsError?.path).toBe(join(s.root, 'system'));
      expect(parsed.findings.filter((f) => f.ruleId === R1_ID || f.proposedFix)).toEqual([]);
    },
  );

  it.each(UNUSABLE_SYSTEM_FIXTURE_NAMES)('%s: fix refuses and writes nothing', async (name) => {
    const s = setup(name);
    const preset = join(s.root, 'user', '1000000001', 'filament', 'Anycubic Petg.json');
    const before = readFileSync(preset, 'utf8');
    for (const argv of [['fix'], ['fix', '--apply', '--yes'], ['fix', '--nozzles', '--apply']]) {
      const r = await s.run(...argv);
      expect(r.code, argv.join(' ')).toBe(EXIT.failed);
      expect(r.err).toContain(`ERROR: ${MESSAGE}`);
      expect(r.err).toContain('nothing was changed');
      expect(r.out).toBe('');
    }
    expect(readFileSync(preset, 'utf8')).toBe(before);
    expect(existsSync(s.backupsDir)).toBe(false);
  });

  it('a folder whose system presets vanish stops being repairable (issue #12068)', async () => {
    const s = setup('broken-r1');
    expect((await s.run('fix')).out).toContain('20 file change(s) planned:');
    // The bug: BBL.json stays, the preset files under system/BBL are gone.
    for (const e of readdirSync(join(s.root, 'system', 'BBL', 'filament'))) {
      rmSync(join(s.root, 'system', 'BBL', 'filament', e), { recursive: true });
    }
    const scanned = await s.run('scan');
    expect(scanned.code).toBe(EXIT.failed);
    expect(scanned.out).toContain(`ERROR: ${MESSAGE}`);
    expect(scanned.out).toContain('Hidden in Studio (0)');
    expect((await s.run('fix', '--apply', '--yes')).code).toBe(EXIT.failed);
    expect(existsSync(s.backupsDir)).toBe(false);

    // ...and a filament_list emptied in place, which used to flag every preset as an orphan.
    const index = join(s.root, 'system', 'BBL.json');
    const json = JSON.parse(readFileSync(index, 'utf8')) as Record<string, unknown>;
    writeFileSync(index, JSON.stringify({ ...json, filament_list: [] }));
    const emptied = await s.run('scan', '--json');
    expect(emptied.code).toBe(EXIT.failed);
    const parsed = JSON.parse(emptied.out) as ScanResult;
    expect(parsed.systemPresets).toBe('empty');
    expect(parsed.findings.filter((f) => f.ruleId === R1_ID)).toEqual([]);
  });

  it('healthy: --json says ok and scan exits 0', async () => {
    const s = setup('healthy');
    const r = await s.run('scan', '--json');
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toBe('');
    const parsed = JSON.parse(r.out) as ScanResult;
    expect(parsed.systemPresets).toBe('ok');
    expect(parsed.systemPresetsError).toBeUndefined();
    expect((await s.run('scan')).out).not.toContain('ERROR');
  });
});
