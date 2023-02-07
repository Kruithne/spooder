module.exports = {
	'env': {
		'node': true,
		'es2021': true
	},
	'extends': [
		'eslint:recommended',
		'plugin:@typescript-eslint/recommended'
	],
	'ignorePatterns': ['*.js', '*.d.ts'],
	'overrides': [
	],
	'parser': '@typescript-eslint/parser',
	'parserOptions': {
		'ecmaVersion': 'latest',
		'sourceType': 'module'
	},
	'plugins': [
		'@typescript-eslint',
		'jest'
	],
	'rules': {
		'@typescript-eslint/no-inferrable-types': 'off',
		'@typescript-eslint/no-explicit-any': 'error',
		'@typescript-eslint/type-annotation-spacing': 'error',
		'@typescript-eslint/space-infix-ops': 'error',
		'@typescript-eslint/explicit-function-return-type': 'error',
		'space-before-blocks': 'error',
		'brace-style': ['error', '1tbs'],
		'curly': [2, 'multi-or-nest', 'consistent'],
		'no-trailing-spaces': 'error',
		'keyword-spacing': 'error',
		'indent': [
			'error',
			'tab',
			{
				'SwitchCase': 1
			}
		],
		'linebreak-style': [
			'error',
			process.platform === 'win32' ? 'windows' : 'unix'
		],
		'quotes': [
			'error',
			'single'
		],
		'semi': [
			'error',
			'always'
		]
	}
};