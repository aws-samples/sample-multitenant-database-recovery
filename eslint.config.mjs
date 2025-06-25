// @ts-check

import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    // Disable the no-explicit-any rule for all TypeScript files
    rules: {
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  {
    // Ignore .js files entirely
    ignores: ['**/*.js']
  }
)
