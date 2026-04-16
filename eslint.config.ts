import antfu from '@antfu/eslint-config'

export default antfu(
  {
    stylistic: true,
    typescript: true,
    jsonc: false,
    yaml: false,
    markdown: false,
    ignores: [
      '**/eslint.config.ts',
      '**/prism.js',
      '**/build',
      '**/logs',
      '**/node_modules',
      '!.vscode',
      '!**/.vscode',
      'src/test/**',
    ],
    overrides: {
      stylistic: {
        'style/space-infix-ops': 'error',
        'style/comma-spacing': ['error', { after: true, before: false }],
        'style/indent': ['error', 2],
        'style/object-curly-spacing': ['error', 'always'],
      },
      typescript: {
        'ts/no-use-before-define': 'off',
        'ts/no-explicit-any': 'off',
        'ts/no-parameter-properties': 'off',
        'ts/no-unused-vars': 'off',
        'ts/no-var-requires': 'off',
        'ts/ban-types': 'off',
        'ts/explicit-function-return-type': 'off',
        'ts/explicit-member-accessibility': 'off',
        'ts/explicit-module-boundary-types': 'off',
        'ts/consistent-type-definitions': 'off',
        'ts/consistent-type-imports': [
          'error',
          {
            disallowTypeAnnotations: false,
            prefer: 'type-imports',
          },
        ],
      },
    },
  },
  {
    rules: {
      'no-console': 'off',
      'no-new': 'off',
      'curly': 'off',
      'antfu/if-newline': 'off',
      'node/prefer-global/process': 'off',
      'unused-imports/no-unused-imports': 'off',
      'unused-imports/no-unused-vars': 'off',
      'unicorn/throw-new-error': 'off',
      'style/operator-linebreak': 'off',
      'style/brace-style': 'off',
      'jsonc/sort-keys': 'off',
      'unicorn/no-instanceof-array': 'off',
      'unicorn/number-literal-case': 'off',
      'unicorn/prefer-includes': 'off',
      'prefer-const': 'off',
      'import/first': 'error',
      'import/newline-after-import': ['error', { count: 1, considerComments: true }],
    },
  },
)
