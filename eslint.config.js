import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**'],
  },
  {
    files: ['packages/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
    },
  },
  {
    // MIT-purity guard: @wiillownet/fastled-math must never import EUPL code.
    // This one-way dependency direction (effects -> math, never the reverse)
    // is the only thing keeping the math package MIT. Permanent; do not relax.
    //
    // Scope: import-based only. It cannot catch EUPL logic copy-pasted into
    // fastled-math without an import statement -- that is covered by the
    // per-function provenance review in PROVENANCE.md, not by this rule.
    files: ['packages/fastled-math/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@wiillownet/wled-fx-sim', '@wiillownet/wled-fx-sim/*'],
              message:
                'MIT-purity violation: fastled-math (MIT) must not import wled-fx-sim (EUPL-1.2).',
            },
            {
              group: ['../*'],
              message:
                'MIT-purity guard: fastled-math imports must stay inside the package (no ../ escapes).',
            },
          ],
        },
      ],
    },
  },
);
