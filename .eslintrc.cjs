/**
 * ESLint configuration.
 *
 * Besides the TypeScript rules this file encodes the layer boundaries of
 * the project: every layer may only import from the layers it is allowed
 * to depend on. The authoritative check is `node scripts/check-layers.mjs`
 * (see docs/architecture.md); this rule is the fast feedback loop that
 * runs while you edit.
 *
 * Implementation notes (all of them were verified against the ESLint
 * version used by this repository):
 *
 *   - `no-restricted-imports` `patterns.group` uses gitignore semantics
 *     (the `ignore` package): a pattern like "star-slash-star-slash-db"
 *     (that is: two stars, a slash, the layer name, a slash and a star)
 *     matches `../db/cards.js` and `../../db/cards.js` alike, and the
 *     group is the list of BANNED import sources.
 *   - the `ignore` package does not expand `{a,b}` braces, so the banned
 *     layer directories are listed one by one.
 *   - several overrides that match the same files overwrite each other
 *     for the same rule key, so the `paths` and the `patterns` of a
 *     layer have to live in a single override.
 *   - `import/no-restricted-paths` is deliberately not used: the default
 *     node resolver does not map `.js` specifiers to `.ts` sources, so
 *     the rule would silently do nothing.
 *
 * The layer matrix below is the same one the checker enforces; keep the
 * two in sync when a layer is added or moved.
 */

/** Every layer of the project (a directory directly under src/). */
const LAYERS = [
  'auth',
  'cli',
  'config',
  'core',
  'daemon',
  'db',
  'embedding',
  'http',
  'runtime',
  'services',
  'storage',
  'worker',
];

/** The target dependency matrix: layer -> layers it may import from. */
const ALLOWED_LAYERS = {
  core: ['core'],
  config: ['core'],
  db: ['core', 'config'],
  auth: ['core', 'config', 'db'],
  embedding: ['core'],
  storage: ['core', 'embedding'],
  services: ['core', 'config', 'db', 'auth'],
  worker: ['core', 'config', 'db', 'services', 'embedding', 'storage'],
  http: ['core', 'config', 'db', 'auth', 'services'],
  runtime: ['core', 'config', 'db', 'auth', 'services', 'worker', 'embedding', 'storage'],
  daemon: LAYERS,
  cli: LAYERS,
};

/** Third-party packages a layer may import. */
const ALLOWED_PACKAGES = {
  core: [],
  config: [],
  db: ['node:sqlite'],
  auth: [],
  embedding: ['@huggingface/transformers'],
  storage: ['@lancedb/lancedb'],
  services: [],
  worker: [],
  http: ['hono', 'zod'],
  runtime: ['node:sqlite'],
  daemon: ['hono', '@hono/node-server'],
  cli: [],
};

/** Every third-party package the checker polices. */
const KNOWN_PACKAGES = [
  'hono',
  'zod',
  '@hono/node-server',
  '@lancedb/lancedb',
  '@huggingface/transformers',
  'node:sqlite',
];

/**
 * The legacy modules that live directly in src/. They are shared by every
 * layer, so they are not a layer of their own, but the pure layers must
 * not reach for them either.
 */
const ROOT_MODULES = ['paths.js', 'semantic-stack.js', 'version.js', 'index.js'];

/**
 * Known deviations from the target architecture.
 *
 * The list is empty: every deviation the refactor started with is
 * closed, so the layer rules below apply to every file without an
 * exemption. The same list lives in scripts/check-layers.mjs.
 */
const KNOWN_DEVIATIONS = [];

/**
 * Build the `no-restricted-imports` configuration of one layer.
 *
 * @param {string} layer the layer the configuration applies to
 * @param {string[]} [exempt] banned patterns that are temporarily allowed
 * @returns {object} the ESLint rule configuration
 */
function layerRule(layer, exempt = []) {
  const allowedLayers = ALLOWED_LAYERS[layer];
  const allowedPackages = ALLOWED_PACKAGES[layer];

  const bannedLayers = LAYERS.filter(
    candidate => candidate !== layer && !allowedLayers.includes(candidate)
  );
  const bannedPackages = KNOWN_PACKAGES.filter(candidate => !allowedPackages.includes(candidate));

  const group = [
    ...bannedLayers.map(name => `**/${name}/*`),
    ...bannedPackages.flatMap(name => [name, `${name}/*`]),
  ].filter(pattern => !exempt.includes(pattern));

  // The pure layers must not reach for the shared top-level modules
  // either; those live directly in src/ and have no layer directory.
  const paths =
    layer === 'core' || layer === 'config'
      ? ROOT_MODULES.flatMap(name => [`../${name}`, `../../${name}`]).map(name => ({
          name,
          message: `The ${layer} layer must not import the shared module "${name}".`,
        }))
      : [];

  return [
    'error',
    {
      paths,
      patterns: [
        {
          group,
          message:
            `The ${layer} layer may only import from ` +
            `${allowedLayers.join(', ')}. See docs/architecture.md.`,
        },
      ],
    },
  ];
}

/** One override per layer, plus one per file with a known deviation. */
const layerOverrides = Object.keys(ALLOWED_LAYERS).map(layer => ({
  files: [`src/${layer}/**`],
  rules: {
    'no-restricted-imports': layerRule(layer),
  },
}));

/**
 * A known deviation removes its pattern for that one file only, so the
 * rest of the layer keeps its protection. Deviations of the same file are
 * merged, because a later override would otherwise replace the exemption
 * of the earlier one.
 */
const deviationOverrides = Object.entries(
  KNOWN_DEVIATIONS.reduce((byFile, deviation) => {
    const entry = byFile[deviation.file] ?? { layer: deviation.layer, banned: [] };
    entry.banned.push(...deviation.banned);
    byFile[deviation.file] = entry;
    return byFile;
  }, {})
).map(([file, deviation]) => ({
  files: [file],
  rules: {
    'no-restricted-imports': layerRule(deviation.layer, deviation.banned),
  },
}));

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: ['./tsconfig.json', './tsconfig.test.json'],
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
    'prettier',
  ],
  rules: {
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/prefer-readonly': 'error',
    '@typescript-eslint/strict-boolean-expressions': 'off',
    'no-console': ['warn', { allow: ['error', 'warn'] }],
    'import/no-unresolved': 'off',
    'import/order': 'off',
  },
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.config.*'],
  overrides: [
    {
      // CLI commands print to stdout/stderr by design
      files: ['src/cli/**'],
      rules: {
        'no-console': 'off',
      },
    },
    ...layerOverrides,
    ...deviationOverrides,
    {
      // Test files
      files: ['test/**/*.ts'],
      rules: {
        '@typescript-eslint/no-unused-vars': 'off',
        '@typescript-eslint/require-await': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
        '@typescript-eslint/unbound-method': 'off',
        '@typescript-eslint/no-unnecessary-type-assertion': 'off',
        // Tests may import from every layer, that is the point of them.
        'no-restricted-imports': 'off',
      },
    },
  ],
};
