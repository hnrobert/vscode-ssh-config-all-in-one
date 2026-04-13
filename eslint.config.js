const antfu = require('@antfu/eslint-config').default

module.exports = antfu(
  {
    stylistic: true,
    typescript: true,
    jsonc: false,
    yaml: false,
    markdown: false,
    ignores: [
      '**/eslint.config.js',
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
        'space-infix-ops': 'error',
        'comma-spacing': ['error', { after: true, before: false }],
        'ts/indent': ['error', 2],
        'object-curly-spacing': 'off',
        'ts/object-curly-spacing': ['error', 'always'],
      },
      typescript: {
        'ts/no-use-before-define': 'off',
        'ts/interface-name-prefix': 'off',
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
        'prefer-const': 'off',
        'unused-imports/no-unused-imports': 'off',
        'unused-imports/no-unused-vars': 'off',
        'import/no-absolute-path': 'off',
        'import/no-named-as-default': 'off',
        'import/no-named-as-default-member': 'off',
        'import/no-self-import': 'error',
        'import/first': 'error',
        'import/namespace': 'off',
        'import/newline-after-import': ['error', { count: 1, considerComments: true }],

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
    }
  },
)
