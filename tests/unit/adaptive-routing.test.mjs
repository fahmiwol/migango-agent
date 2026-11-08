// Kimi draft; Codex corrected route/policy to the preregistered contract before implementation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyseTask,
  planTask,
  validatePolicy,
  providerEffort,
} from '../../src/core/adaptive-routing.mjs';

// ── Fixtures ──────────────────────────────────────────────────────────
const registry = Object.freeze([
  Object.freeze({
    id: 'kimi',
    provider: 'kimi',
    model: 'kimi-k2.6',
    credentialId: 'kimi',
    capabilities: Object.freeze(['text', 'tools', 'code']),
    enabled: true,
  }),
  Object.freeze({
    id: 'opus',
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    credentialId: 'anthropic',
    capabilities: Object.freeze(['text', 'tools', 'code']),
    enabled: true,
  }),
]);

const settings = Object.freeze({
  adaptiveRouting: Object.freeze({
    version: 1,
    enabled: true,
    models: Object.freeze({
      low: 'kimi',
      medium: 'kimi',
      high: 'opus',
    }),
  }),
});

// ── Tests ─────────────────────────────────────────────────────────────
describe('adaptive-routing', () => {
  describe('analyseTask', () => {
    it('"Halo apa kabar" → route conversation, level low, non-critical', () => {
      const result = analyseTask('Halo apa kabar');
      assert.equal(result.route, 'conversation');
      assert.equal(result.level, 'low');
      assert.equal(result.critical, false);
    });

    it('"Implementasikan fungsi baru" → route coding, level medium, non-critical', () => {
      const result = analyseTask('Implementasikan fungsi baru');
      assert.equal(result.route, 'coding');
      assert.equal(result.level, 'medium');
      assert.equal(result.critical, false);
    });

    it('"Audit keamanan pembayaran produksi" → route review, level high, critical true', () => {
      const result = analyseTask('Audit keamanan pembayaran produksi');
      assert.equal(result.route, 'review');
      assert.equal(result.level, 'high');
      assert.equal(result.critical, true);
    });

    // Red case from evidence/route-negative-20261025/risk-words-red.json (2 PASS, 3 FAIL).
    for (const prompt of ['deployment', 'migrations', 'payments', 'security', 'payment']) {
      it(`"${prompt}" → level high, critical true`, () => {
        const result = analyseTask(prompt);
        assert.equal(result.critical, true);
        assert.equal(result.level, 'high');
        assert.ok(result.signals.includes('critical-risk'));
      });
    }

    it('kata yang hanya berawalan sama tidak dianggap critical', () => {
      const result = analyseTask('paymentsheet');
      assert.equal(result.critical, false);
      assert.equal(result.level, 'low');
    });
  });

  describe('planTask', () => {
    it('level low memilih profil kimi dan agen default migan', () => {
      const result = planTask({ prompt: 'Halo', settings, registry });
      assert.equal(result.profile.id, 'kimi');
      assert.equal(result.agent.id, 'migan');
      assert.equal(result.level, 'low');
      assert.equal(result.route, 'conversation');
      assert.ok(result.effort);
    });

    it('level high memilih profil opus dan agen default migan', () => {
      const result = planTask({
        prompt: 'Audit keamanan',
        settings,
        registry,
      });
      assert.equal(result.profile.id, 'opus');
      assert.equal(result.agent.id, 'migan');
      assert.equal(result.level, 'high');
      assert.equal(result.route, 'review');
      assert.ok(result.effort);
    });

    it('explicit modelId kimi mengalahkan route high, namun level tetap high dan critical true', () => {
      const result = planTask({
        prompt: 'Audit keamanan pembayaran produksi',
        settings,
        registry,
        modelId: 'kimi',
      });
      assert.equal(result.profile.id, 'kimi');
      assert.equal(result.level, 'high');
      assert.equal(result.critical, true);
    });

    it('advice low berkeyakinan tinggi tidak menurunkan varian critical "payments"', () => {
      const result = planTask({
        prompt: 'payments',
        settings,
        registry,
        suggestion: { route: 'conversation', level: 'low', confidence: 0.99, abstain: false },
      });
      assert.equal(result.critical, true);
      assert.equal(result.level, 'high');
      assert.equal(result.profile.id, 'opus');
      assert.equal(result.source, 'rules+validated-advice');
    });

    it('explicit modelId kimi tetap dihormati pada "deployment", level tetap high', () => {
      const result = planTask({ prompt: 'deployment', settings, registry, modelId: 'kimi' });
      assert.equal(result.profile.id, 'kimi');
      assert.equal(result.level, 'high');
      assert.equal(result.critical, true);
      assert.equal(result.selectionReason, 'Explicit owner model override');
    });
  });

  describe('validatePolicy', () => {
    it('menolak policy dengan model ID yang tidak ada di registry', () => {
      const policy = { ...settings.adaptiveRouting, models:{low:'unknown-model',medium:'kimi',high:'opus'} };
      assert.throws(
        () => validatePolicy(policy, registry),
        /unknown|not found|invalid/i,
      );
    });

    it('menerima policy dengan model ID yang terdaftar', () => {
      const policy = settings.adaptiveRouting;
      assert.doesNotThrow(() => validatePolicy(policy, registry));
    });
  });

  describe('providerEffort', () => {
    it('Kimi level low → native.thinking.type disabled', () => {
      const profile = registry.find((p) => p.id === 'kimi');
      const result = providerEffort(profile, 'low');
      assert.equal(result.native.thinking.type, 'disabled');
      assert.equal(result.applied, true);
      assert.ok(typeof result.note === 'string');
    });

    it('Kimi level medium → native.thinking.type enabled', () => {
      const profile = registry.find((p) => p.id === 'kimi');
      const result = providerEffort(profile, 'medium');
      assert.equal(result.native.thinking.type, 'enabled');
      assert.equal(result.applied, true);
      assert.ok(typeof result.note === 'string');
    });

    it('Opus level high → native.output_config.effort high', () => {
      const profile = registry.find((p) => p.id === 'opus');
      const result = providerEffort(profile, 'high');
      assert.equal(result.native.output_config.effort, 'high');
      assert.equal(result.applied, true);
      assert.ok(typeof result.note === 'string');
    });

    it('model tak dikenal → applied false tanpa error', () => {
      const unknownProfile = Object.freeze({
        id: 'unknown',
        provider: 'fake',
        model: 'fake-model',
      });
      const result = providerEffort(unknownProfile, 'low');
      assert.equal(result.applied, false);
    });
  });
});
