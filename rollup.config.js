import fs from 'fs'
import path from 'path'
import ts from 'rollup-plugin-typescript2'
import replace from '@rollup/plugin-replace'
import json from '@rollup/plugin-json'
import alias from '@rollup/plugin-alias'
import nodeResolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import { getBabelOutputPlugin } from '@rollup/plugin-babel'

if (!process.env.TARGET) {
  throw new Error('TARGET package must be specified via --environment flag.')
}

const packagesDir = path.resolve(__dirname, 'packages')
const packageDir = path.resolve(packagesDir, process.env.TARGET)
const resolve = (p) => path.resolve(packageDir, p)
const pkg = require(resolve(`package.json`))

// ensure TS checks only once for each build
let hasTSChecked = false

const configs = []

let buildOptions = require(resolve(`build.json`))

function normalizeOutput(file, output = {}) {
  return Object.assign(
    {
      file,
      format: file.includes('.cjs.') ? 'cjs' : 'es',
      exports: 'auto',
    },
    output
  )
}

if (!Array.isArray(buildOptions)) {
  buildOptions = [buildOptions]
}
buildOptions.forEach((buildOption) => {
  Object.keys(buildOption.input).forEach((name) => {
    const files = buildOption.input[name]
    if (Array.isArray(files)) {
      files.forEach((file) => {
        configs.push(
          createConfig(
            name,
            normalizeOutput(resolve(file), buildOption.output),
            buildOption
          )
        )
      })
    } else {
      configs.push(
        createConfig(
          name,
          normalizeOutput(resolve(buildOption.input[name]), buildOption.output),
          buildOption
        )
      )
    }
  })
})

export default configs

function resolveTsconfigJson() {
  const tsconfigJsonPath = resolve('tsconfig.json')
  if (
    fs.existsSync(tsconfigJsonPath)
    //  &&
    // require(tsconfigJsonPath).extends === '../../tsconfig.json'
  ) {
    return tsconfigJsonPath
  }
  return path.resolve(__dirname, 'tsconfig.json')
}

function createConfig(entryFile, output, buildOption) {
  const shouldEmitDeclarations = process.env.TYPES != null && !hasTSChecked
  const tsPlugin = ts({
    check:
      !process.env.CI && process.env.NODE_ENV === 'production' && !hasTSChecked,
    tsconfig: resolveTsconfigJson(),
    cacheRoot: path.resolve(__dirname, 'node_modules/.rts2_cache'),
    tsconfigOverride: {
      compilerOptions: {
        sourceMap: output.sourcemap,
        declaration: shouldEmitDeclarations,
        declarationMap: false,
      },
      exclude: ['**/__tests__', 'test-dts'],
    },
    useTsconfigDeclarationDir: true,
  })

  // we only need to check TS and generate declarations once for each build.
  // it also seems to run into weird issues when checking multiple times
  // during a single build.
  hasTSChecked = true

  const external =
    buildOption.external === false
      ? []
      : Array.isArray(buildOption.external)
      ? buildOption.external
      : [
          'vue',
          '@vue/shared',
          ...Object.keys(pkg.dependencies || {}),
          ...Object.keys(pkg.peerDependencies || {}),
          ...(buildOption.external || []),
        ]
  const plugins = [
    createAliasPlugin(buildOption),
    nodeResolve(),
    commonjs(),
    json({
      // namedExports: false,
    }),
    tsPlugin,
    createReplacePlugin(buildOption, output.format),
  ]
  if (buildOption.babel) {
    // TODO weex 使用了 buble 编译，暂时先通过 babel 编译一遍，避免 buble 编译失败
    plugins.push(
      getBabelOutputPlugin({
        allowAllFormats: true,
        sourceType: 'module',
        presets: [['@babel/preset-env', { targets: ['iOS 10'] }]],
      })
    )
  }
  if (buildOption.replaceAfterBundled) {
    const replacements = buildOption.replaceAfterBundled
    plugins.push({
      name: 'replace-after-bundled',
      generateBundle(_options, bundles) {
        Object.keys(bundles).forEach((name) => {
          const bundle = bundles[name]
          if (!bundle.code) {
            return
          }
          Object.keys(replacements).forEach((replacement) => {
            bundle.code = bundle.code.replace(
              new RegExp(replacement, 'g'),
              replacements[replacement]
            )
          })
        })
      },
    })
  }

  return {
    input: resolve(entryFile),
    external,
    plugins,
    output,
    onwarn: (msg, warn) => {
      // if (!/Circular/.test(msg)) {
      warn(msg)
      // }
    },
    treeshake:
      buildOption.treeshake === false
        ? false
        : {
            moduleSideEffects(id) {
              if (id.endsWith('polyfill.ts')) {
                console.log('[WARN]:sideEffects[' + id + ']')
                return true
              }
              return false
            },
          },
  }
}

function createAliasPlugin(buildOption) {
  return alias(buildOption.alias || {})
}

function createReplacePlugin(buildOption, format) {
  const replacements = {
    global: format === 'cjs' ? 'global' : 'window',
    __DEV__: `(process.env.NODE_ENV !== 'production')`,
    __TEST__: false,
    __NODE_JS__: format === 'cjs',
  }
  if (buildOption.replacements) {
    Object.assign(replacements, buildOption.replacements)
  }

  Object.keys(replacements).forEach((key) => {
    if (key in process.env) {
      replacements[key] = process.env[key]
    }
  })
  return replace({ values: replacements, preventAssignment: true })
}
