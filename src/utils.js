const path = require("path");

/** @typedef {import("./index").WorkerResult} WorkerResult */
/** @typedef {import("./index").SquooshOptions} SquooshOptions */
/** @typedef {import("imagemin").Options} ImageminOptions */
/** @typedef {import("webpack").WebpackError} WebpackError */
/** @typedef {import("webpack").Module} Module */
/** @typedef {import("webpack").AssetInfo} AssetInfo */

/**
 * @template T
 * @typedef {() => Promise<T>} Task
 */

/**
 * @param {string} filename file path without query params (e.g. `path/img.png`)
 * @param {string} ext new file extension without `.` (e.g. `webp`)
 * @returns {string} new filename `path/img.png` -> `path/img.webp`
 */
function replaceFileExtension(filename, ext) {
  let dotIndex = -1;

  for (let i = filename.length - 1; i > -1; i--) {
    const char = filename[i];

    if (char === ".") {
      dotIndex = i;
      break;
    }

    if (char === "/" || char === "\\") {
      break;
    }
  }

  if (dotIndex === -1) {
    return filename;
  }

  return `${filename.slice(0, dotIndex)}.${ext}`;
}

/**
 * Run tasks with limited concurrency.
 * @template T
 * @param {number} limit - Limit of tasks that run at once.
 * @param {Task<T>[]} tasks - List of tasks to run.
 * @returns {Promise<T[]>} A promise that fulfills to an array of the results
 */
function throttleAll(limit, tasks) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError(
      `Expected 'limit' to be a finite number > 0, got \`${limit}\` (${typeof limit})`,
    );
  }

  if (
    !Array.isArray(tasks) ||
    !tasks.every((task) => typeof task === "function")
  ) {
    throw new TypeError(
      "Expected 'tasks' to be a list of functions returning a promise",
    );
  }

  return new Promise((resolve, reject) => {
    const result = /** @type {T[]} */ ([]);
    const entries = tasks.entries();
    let tasksFulfilled = 0;

    const next = () => {
      const { done, value } = entries.next();

      if (done) {
        if (tasksFulfilled === tasks.length) {
          resolve(result);
          return;
        }

        return;
      }

      const [index, task] = value;

      /**
       * @param {T} taskResult
       */
      const onFulfilled = (taskResult) => {
        result[index] = taskResult;
        tasksFulfilled += 1;
        next();
      };

      task().then(onFulfilled, reject);
    };

    for (let i = 0; i < limit; i++) {
      next();
    }
  });
}

const ABSOLUTE_URL_REGEX = /^[a-zA-Z][a-zA-Z\d+\-.]*?:/;
const WINDOWS_PATH_REGEX = /^[a-zA-Z]:\\/;
const POSIX_PATH_REGEX = /^\//;

/**
 * @param {string} url
 * @returns {boolean}
 */
function isAbsoluteURL(url) {
  return (
    WINDOWS_PATH_REGEX.test(url) ||
    POSIX_PATH_REGEX.test(url) ||
    ABSOLUTE_URL_REGEX.test(url)
  );
}

/**
 * @callback Uint8ArrayUtf8ByteString
 * @param {number[] | Uint8Array} array
 * @param {number} start
 * @param {number} end
 * @returns {string}
 */

/** @type {Uint8ArrayUtf8ByteString} */
const uint8ArrayUtf8ByteString = (array, start, end) =>
  String.fromCodePoint(...array.slice(start, end));

/**
 * @callback StringToBytes
 * @param {string} string
 * @returns {number[]}
 */

/** @type {StringToBytes} */
const stringToBytes = (string) =>
  // eslint-disable-next-line unicorn/prefer-code-point
  [...string].map((character) => character.charCodeAt(0));

/**
 * @param {ArrayBuffer | ArrayLike<number>} input
 * @returns {{ext: string, mime: string} | undefined}
 */
function fileTypeFromBuffer(input) {
  if (
    !(
      input instanceof Uint8Array ||
      input instanceof ArrayBuffer ||
      Buffer.isBuffer(input)
    )
  ) {
    throw new TypeError(
      `Expected the \`input\` argument to be of type \`Uint8Array\` or \`Buffer\` or \`ArrayBuffer\`, got \`${typeof input}\``,
    );
  }

  const buffer = input instanceof Uint8Array ? input : new Uint8Array(input);

  if (!(buffer && buffer.length > 1)) {
    return;
  }

  /**
   * @param {number[]} header
   * @param {{offset: number, mask?: number[]}} [options]
   * @returns {boolean}
   */
  const check = (header, options) => {
    // eslint-disable-next-line no-param-reassign
    options = {
      offset: 0,
      ...options,
    };

    for (let i = 0; i < header.length; i++) {
      if (options.mask) {
        // eslint-disable-next-line no-bitwise
        if (header[i] !== (options.mask[i] & buffer[i + options.offset])) {
          return false;
        }
      } else if (header[i] !== buffer[i + options.offset]) {
        return false;
      }
    }

    return true;
  };

  /**
   * @param {string} header
   * @param {{offset: number, mask?: number[]}} [options]
   * @returns {boolean}
   */
  const checkString = (header, options) =>
    check(stringToBytes(header), options);

  if (check([0xff, 0xd8, 0xff])) {
    return {
      ext: "jpg",
      mime: "image/jpeg",
    };
  }

  if (check([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    // APNG format (https://wiki.mozilla.org/APNG_Specification)
    // 1. Find the first IDAT (image data) chunk (49 44 41 54)
    // 2. Check if there is an "acTL" chunk before the IDAT one (61 63 54 4C)

    // Offset calculated as follows:
    // - 8 bytes: PNG signature
    // - 4 (length) + 4 (chunk type) + 13 (chunk data) + 4 (CRC): IHDR chunk
    const startIndex = 33;
    const firstImageDataChunkIndex = buffer.findIndex(
      (el, i) =>
        i >= startIndex &&
        buffer[i] === 0x49 &&
        buffer[i + 1] === 0x44 &&
        buffer[i + 2] === 0x41 &&
        buffer[i + 3] === 0x54,
    );
    const sliced = buffer.subarray(startIndex, firstImageDataChunkIndex);

    if (
      sliced.findIndex(
        (el, i) =>
          sliced[i] === 0x61 &&
          sliced[i + 1] === 0x63 &&
          sliced[i + 2] === 0x54 &&
          sliced[i + 3] === 0x4c,
      ) >= 0
    ) {
      return {
        ext: "apng",
        mime: "image/apng",
      };
    }

    return {
      ext: "png",
      mime: "image/png",
    };
  }

  if (check([0x47, 0x49, 0x46])) {
    return {
      ext: "gif",
      mime: "image/gif",
    };
  }

  if (check([0x57, 0x45, 0x42, 0x50], { offset: 8 })) {
    return {
      ext: "webp",
      mime: "image/webp",
    };
  }

  if (check([0x46, 0x4c, 0x49, 0x46])) {
    return {
      ext: "flif",
      mime: "image/flif",
    };
  }

  // `cr2`, `orf`, and `arw` need to be before `tif` check
  if (
    (check([0x49, 0x49, 0x2a, 0x0]) || check([0x4d, 0x4d, 0x0, 0x2a])) &&
    check([0x43, 0x52], { offset: 8 })
  ) {
    return {
      ext: "cr2",
      mime: "image/x-canon-cr2",
    };
  }

  if (check([0x49, 0x49, 0x52, 0x4f, 0x08, 0x00, 0x00, 0x00, 0x18])) {
    return {
      ext: "orf",
      mime: "image/x-olympus-orf",
    };
  }

  if (
    check([0x49, 0x49, 0x2a, 0x00]) &&
    (check([0x10, 0xfb, 0x86, 0x01], { offset: 4 }) ||
      check([0x08, 0x00, 0x00, 0x00], { offset: 4 })) &&
    // This pattern differentiates ARW from other TIFF-ish file types:
    check(
      [
        0x00, 0xfe, 0x00, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
        0x00, 0x03, 0x01,
      ],
      { offset: 9 },
    )
  ) {
    return {
      ext: "arw",
      mime: "image/x-sony-arw",
    };
  }

  if (
    check([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]) &&
    (check([0x2d, 0x00, 0xfe, 0x00], { offset: 8 }) ||
      check([0x27, 0x00, 0xfe, 0x00], { offset: 8 }))
  ) {
    return {
      ext: "dng",
      mime: "image/x-adobe-dng",
    };
  }

  if (
    check([0x49, 0x49, 0x2a, 0x00]) &&
    check([0x1c, 0x00, 0xfe, 0x00], { offset: 8 })
  ) {
    return {
      ext: "nef",
      mime: "image/x-nikon-nef",
    };
  }

  if (
    check([
      0x49, 0x49, 0x55, 0x00, 0x18, 0x00, 0x00, 0x00, 0x88, 0xe7, 0x74, 0xd8,
    ])
  ) {
    return {
      ext: "rw2",
      mime: "image/x-panasonic-rw2",
    };
  }

  // `raf` is here just to keep all the raw image detectors together.
  if (checkString("FUJIFILMCCD-RAW")) {
    return {
      ext: "raf",
      mime: "image/x-fujifilm-raf",
    };
  }

  if (check([0x49, 0x49, 0x2a, 0x0]) || check([0x4d, 0x4d, 0x0, 0x2a])) {
    return {
      ext: "tif",
      mime: "image/tiff",
    };
  }

  if (check([0x42, 0x4d])) {
    return {
      ext: "bmp",
      mime: "image/bmp",
    };
  }

  if (check([0x49, 0x49, 0xbc])) {
    return {
      ext: "jxr",
      mime: "image/vnd.ms-photo",
    };
  }

  if (check([0x38, 0x42, 0x50, 0x53])) {
    return {
      ext: "psd",
      mime: "image/vnd.adobe.photoshop",
    };
  }

  if (
    checkString("ftyp", { offset: 4 }) &&
    // eslint-disable-next-line no-bitwise
    (buffer[8] & 0x60) !== 0x00 // Brand major, first character ASCII?
  ) {
    // They all can have MIME `video/mp4` except `application/mp4` special-case which is hard to detect.
    // For some cases, we're specific, everything else falls to `video/mp4` with `mp4` extension.
    const brandMajor = uint8ArrayUtf8ByteString(buffer, 8, 12)
      .replace("\0", " ")
      .trim();

    // eslint-disable-next-line default-case
    switch (brandMajor) {
      case "avif":
        return { ext: "avif", mime: "image/avif" };
      case "mif1":
        return { ext: "heic", mime: "image/heif" };
      case "msf1":
        return { ext: "heic", mime: "image/heif-sequence" };
      case "heic":
      case "heix":
        return { ext: "heic", mime: "image/heic" };
      case "hevc":
      case "hevx":
        return { ext: "heic", mime: "image/heic-sequence" };
    }
  }

  if (check([0x00, 0x00, 0x01, 0x00])) {
    return {
      ext: "ico",
      mime: "image/x-icon",
    };
  }

  if (check([0x00, 0x00, 0x02, 0x00])) {
    return {
      ext: "cur",
      mime: "image/x-icon",
    };
  }

  if (check([0x42, 0x50, 0x47, 0xfb])) {
    return {
      ext: "bpg",
      mime: "image/bpg",
    };
  }

  if (
    check([
      0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a,
    ])
  ) {
    // JPEG-2000 family

    if (check([0x6a, 0x70, 0x32, 0x20], { offset: 20 })) {
      return {
        ext: "jp2",
        mime: "image/jp2",
      };
    }

    if (check([0x6a, 0x70, 0x78, 0x20], { offset: 20 })) {
      return {
        ext: "jpx",
        mime: "image/jpx",
      };
    }

    if (check([0x6a, 0x70, 0x6d, 0x20], { offset: 20 })) {
      return {
        ext: "jpm",
        mime: "image/jpm",
      };
    }

    if (check([0x6d, 0x6a, 0x70, 0x32], { offset: 20 })) {
      return {
        ext: "mj2",
        mime: "image/mj2",
      };
    }
  }

  if (
    check([0xff, 0x0a]) ||
    check([
      0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a,
    ])
  ) {
    return {
      ext: "jxl",
      mime: "image/jxl",
    };
  }

  if (
    check([
      0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
    ])
  ) {
    return {
      ext: "ktx",
      mime: "image/ktx",
    };
  }
}

/**
 * @template T
 * @param fn {(function(): any) | undefined}
 * @returns {function(): T}
 */
function memoize(fn) {
  let cache = false;
  /** @type {T} */
  let result;

  return () => {
    if (cache) {
      return result;
    }

    result = /** @type {function(): any} */ (fn)();
    cache = true;
    // Allow to clean up memory for fn
    // and all dependent resources
    // eslint-disable-next-line no-param-reassign
    fn = undefined;

    return result;
  };
}

/**
 * @typedef {Object} MetaData
 * @property {Array<Error>} warnings
 * @property {Array<Error>} errors
 */

class InvalidConfigError extends Error {
  /**
   * @param {string | undefined} message
   */
  constructor(message) {
    super(message);

    this.name = "InvalidConfigError";
  }
}

/**
 * @template T
 * @param {ImageminOptions} imageminConfig
 * @returns {Promise<ImageminOptions>}
 */
async function imageminNormalizeConfig(imageminConfig) {
  if (
    !imageminConfig ||
    !imageminConfig.plugins ||
    (imageminConfig.plugins && imageminConfig.plugins.length === 0)
  ) {
    throw new Error(
      "No plugins found for `imagemin`, please read documentation",
    );
  }

  /**
   * @type {import("imagemin").Plugin[]}
   */
  const plugins = [];

  for (const plugin of imageminConfig.plugins) {
    const isPluginArray = Array.isArray(plugin);

    if (typeof plugin === "string" || isPluginArray) {
      const pluginName = isPluginArray ? plugin[0] : plugin;
      const pluginOptions = isPluginArray ? plugin[1] : undefined;

      let requiredPlugin = null;
      let requiredPluginName = pluginName.startsWith("imagemin")
        ? pluginName
        : `imagemin-${pluginName}`;

      try {
        // @ts-ignore
        // eslint-disable-next-line no-await-in-loop
        requiredPlugin = (await import(requiredPluginName)).default(
          pluginOptions,
        );
      } catch {
        requiredPluginName = pluginName;

        try {
          // @ts-ignore
          // eslint-disable-next-line no-await-in-loop
          requiredPlugin = (await import(requiredPluginName)).default(
            pluginOptions,
          );
        } catch (error) {
          const pluginNameForError = pluginName.startsWith("imagemin")
            ? pluginName
            : `imagemin-${pluginName}`;

          throw new Error(
            `Unknown plugin: ${pluginNameForError}\n\nDid you forget to install the plugin?\nYou can install it with:\n\n$ npm install ${pluginNameForError} --save-dev\n$ yarn add ${pluginNameForError} --dev`,
            { cause: error },
          );
        }
        // Nothing
      }

      // let version = "unknown";

      // try {
      //   // eslint-disable-next-line import/no-dynamic-require
      //   ({ version } = require(`${requiredPluginName}/package.json`));
      // } catch {
      //   // Nothing
      // }

      // /** @type {Array<Object>} imageminConfig.pluginsMeta */
      // pluginsMeta.push([
      //   {
      //     name: requiredPluginName,
      //     options: pluginOptions || {},
      //     version,
      //   },
      // ]);

      plugins.push(requiredPlugin);
    } else {
      throw new InvalidConfigError(
        `Invalid plugin configuration '${JSON.stringify(
          plugin,
        )}', plugin configuration should be 'string' or '[string, object]'"`,
      );
    }
  }

  return { plugins };
}

/**
 * @template T
 * @param {WorkerResult} original
 * @param {T} minimizerOptions
 * @returns {Promise<WorkerResult | null>}
 */
async function imageminGenerate(original, minimizerOptions) {
  const minimizerOptionsNormalized = /** @type {ImageminOptions} */ (
    await imageminNormalizeConfig(
      /** @type {ImageminOptions} */ (
        /** @type {?} */ (minimizerOptions ?? {})
      ),
    )
  );

  // @ts-ignore
  // eslint-disable-next-line node/no-unpublished-import
  const imagemin = (await import("imagemin")).default;

  let result;

  try {
    // @ts-ignore
    result = await imagemin.buffer(original.data, minimizerOptionsNormalized);
  } catch (error) {
    const originalError =
      error instanceof Error ? error : new Error(/** @type {string} */ (error));
    const newError = new Error(
      `Error with '${original.filename}': ${originalError.message}`,
    );

    original.errors.push(newError);
    return null;
  }

  const { ext: extOutput } = fileTypeFromBuffer(result) || {};
  const extInput = path.extname(original.filename).slice(1).toLowerCase();

  let newFilename = original.filename;

  if (extOutput && extInput !== extOutput) {
    newFilename = replaceFileExtension(original.filename, extOutput);
  }

  return {
    filename: newFilename,
    // imagemin@8 returns buffer, but imagemin@9 returns uint8array
    data: !Buffer.isBuffer(result) ? Buffer.from(result) : result,
    warnings: [...original.warnings],
    errors: [...original.errors],
    info: {
      ...original.info,
      generated: true,
      generatedBy: ["imagemin", ...(original.info?.generatedBy ?? [])],
    },
  };
}

/**
 * @template T
 * @param {WorkerResult} original
 * @param {T} options
 * @returns {Promise<WorkerResult | null>}
 */
async function imageminMinify(original, options) {
  const minimizerOptionsNormalized = /** @type {ImageminOptions} */ (
    await imageminNormalizeConfig(
      /** @type {ImageminOptions} */ (/** @type {?} */ (options ?? {})),
    )
  );

  // @ts-ignore
  // eslint-disable-next-line node/no-unpublished-import
  const imagemin = (await import("imagemin")).default;

  let result;

  try {
    // @ts-ignore
    result = await imagemin.buffer(original.data, minimizerOptionsNormalized);
  } catch (error) {
    const originalError =
      error instanceof Error ? error : new Error(/** @type {string} */ (error));
    const newError = new Error(
      `Error with '${original.filename}': ${originalError.message}`,
    );

    original.errors.push(newError);
    return null;
  }

  if (!isAbsoluteURL(original.filename)) {
    const extInput = path.extname(original.filename).slice(1).toLowerCase();
    const { ext: extOutput } = fileTypeFromBuffer(result) || {};

    if (extOutput && extInput !== extOutput) {
      original.warnings.push(
        new Error(
          `"imageminMinify" function do not support generate to "${extOutput}" from "${original.filename}". Please use "imageminGenerate" function.`,
        ),
      );

      return null;
    }
  }

  return {
    filename: original.filename,
    // imagemin@8 returns buffer, but imagemin@9 returns uint8array
    data: !Buffer.isBuffer(result) ? Buffer.from(result) : result,
    warnings: [...original.warnings],
    errors: [...original.errors],
    info: {
      ...original.info,
      minimized: true,
      minimizedBy: ["imagemin", ...(original.info?.minimizedBy ?? [])],
    },
  };
}

/**
 * @type {any}
 */
let pool;

/**
 * @param {number} threads
 * @returns {any}
 */
function squooshImagePoolCreate(threads = 1) {
  // eslint-disable-next-line node/no-unpublished-require
  const { ImagePool } = require("@squoosh/lib");

  // TODO https://github.com/GoogleChromeLabs/squoosh/issues/1111,
  // TODO https://github.com/GoogleChromeLabs/squoosh/issues/1012
  //
  // Due to the above errors, we use the value "1", it is faster and consumes less memory in common use.
  //
  // Also we don't know how many image (modules are built asynchronously) we will have so we can't setup
  // the correct value and creating child processes takes a long time, unfortunately there is no perfect solution here,
  // maybe we should provide an option for this (or API for warm up), so if you are reading this feel free to open the issue
  return new ImagePool(threads);
}

function squooshImagePoolSetup() {
  if (!pool) {
    const os = require("os");
    // In some cases cpus() returns undefined
    // https://github.com/nodejs/node/issues/19022
    const threads = os.cpus()?.length ?? 1;

    pool = squooshImagePoolCreate(threads);

    // workarounds for https://github.com/GoogleChromeLabs/squoosh/issues/1152
    // @ts-ignore
    delete globalThis.navigator;
  }
}

async function squooshImagePoolTeardown() {
  if (pool) {
    await pool.close();

    // eslint-disable-next-line require-atomic-updates
    pool = undefined;
  }
}

/**
 * @template T
 * @param {WorkerResult} original
 * @param {T} minifyOptions
 * @returns {Promise<WorkerResult | null>}
 */
async function squooshGenerate(original, minifyOptions) {
  // eslint-disable-next-line node/no-unpublished-require
  const squoosh = require("@squoosh/lib");
  const isReusePool = Boolean(pool);
  const imagePool = pool || squooshImagePoolCreate();
  const image = imagePool.ingestImage(new Uint8Array(original.data));

  const squooshOptions = /** @type {SquooshOptions} */ (minifyOptions ?? {});

  const preprocEntries = Object.entries(squooshOptions).filter(
    ([key, value]) => {
      if (key === "resize" && value?.enabled === false) {
        return false;
      }

      return typeof squoosh.preprocessors[key] !== "undefined";
    },
  );

  if (preprocEntries.length > 0) {
    await image.preprocess(Object.fromEntries(preprocEntries));
  }

  const { encodeOptions } = squooshOptions;

  try {
    await image.encode(encodeOptions);
  } catch (error) {
    if (!isReusePool) {
      await imagePool.close();
    }

    const originalError =
      error instanceof Error ? error : new Error(/** @type {string} */ (error));
    const newError = new Error(
      `Error with '${original.filename}': ${originalError.message}`,
    );

    original.errors.push(newError);
    return null;
  }

  if (!isReusePool) {
    await imagePool.close();
  }

  if (Object.keys(image.encodedWith).length === 0) {
    original.errors.push(
      new Error(
        `No result from 'squoosh' for '${original.filename}', please configure the 'encodeOptions' option to generate images`,
      ),
    );

    return null;
  }

  if (Object.keys(image.encodedWith).length > 1) {
    original.errors.push(
      new Error(
        `Multiple values for the 'encodeOptions' option is not supported for '${original.filename}', specify only one codec for the generator`,
      ),
    );

    return null;
  }

  const { binary, extension } = await Object.values(image.encodedWith)[0];
  const { width, height } = (await image.decoded).bitmap;

  const filename = replaceFileExtension(original.filename, extension);

  return {
    filename,
    data: Buffer.from(binary),
    warnings: [...original.warnings],
    errors: [...original.errors],
    info: {
      ...original.info,
      width,
      height,
      generated: true,
      generatedBy: ["squoosh", ...(original.info?.generatedBy ?? [])],
    },
  };
}

squooshGenerate.setup = squooshImagePoolSetup;

squooshGenerate.teardown = squooshImagePoolTeardown;

/**
 * @template T
 * @param {WorkerResult} original
 * @param {T} options
 * @returns {Promise<WorkerResult | null>}
 */
async function squooshMinify(original, options) {
  // eslint-disable-next-line node/no-unpublished-require
  const squoosh = require("@squoosh/lib");
  const { encoders } = squoosh;

  /**
   * @type {Record<string, string>}
   */
  const targets = {};

  for (const [codec, { extension }] of Object.entries(encoders)) {
    const extensionNormalized = extension.toLowerCase();

    if (extensionNormalized === "jpg") {
      targets.jpeg = codec;
    }

    targets[extensionNormalized] = codec;
  }

  const ext = path.extname(original.filename).slice(1).toLowerCase();
  const targetCodec = targets[ext];

  if (!targetCodec) {
    return null;
  }

  const isReusePool = Boolean(pool);
  const imagePool = pool || squooshImagePoolCreate();
  const image = imagePool.ingestImage(new Uint8Array(original.data));
  const squooshOptions = /** @type {SquooshOptions} */ (options ?? {});

  const preprocEntries = Object.entries(squooshOptions).filter(
    ([key, value]) => {
      if (key === "resize" && value?.enabled === false) {
        return false;
      }

      return typeof squoosh.preprocessors[key] !== "undefined";
    },
  );

  if (preprocEntries.length > 0) {
    await image.preprocess(Object.fromEntries(preprocEntries));
  }

  const { encodeOptions = {} } = squooshOptions;

  if (!encodeOptions[targetCodec]) {
    encodeOptions[targetCodec] = {};
  }

  try {
    await image.encode({ [targetCodec]: encodeOptions[targetCodec] });
  } catch (error) {
    if (!isReusePool) {
      await imagePool.close();
    }

    const originalError =
      error instanceof Error ? error : new Error(/** @type {string} */ (error));
    const newError = new Error(
      `Error with '${original.filename}': ${originalError.message}`,
    );

    original.errors.push(newError);
    return null;
  }

  if (!isReusePool) {
    await imagePool.close();
  }

  const { binary } = await image.encodedWith[targets[ext]];
  const { width, height } = (await image.decoded).bitmap;

  return {
    filename: original.filename,
    data: Buffer.from(binary),
    warnings: [...original.warnings],
    errors: [...original.errors],
    info: {
      ...original.info,
      width,
      height,
      minimized: true,
      minimizedBy: ["squoosh", ...(original.info?.minimizedBy ?? [])],
    },
  };
}

squooshMinify.setup = squooshImagePoolSetup;

squooshMinify.teardown = squooshImagePoolTeardown;

/** @typedef {import("sharp")} SharpLib */
/** @typedef {import("sharp").Sharp} Sharp */
/** @typedef {import("sharp").ResizeOptions & { enabled?: boolean; unit?: "px" | "percent" }} ResizeOptions */

/**
 * @typedef SharpEncodeOptions
 * @type {object}
 * @property {import("sharp").AvifOptions} [avif]
 * @property {import("sharp").GifOptions} [gif]
 * @property {import("sharp").HeifOptions} [heif]
 * @property {import("sharp").JpegOptions} [jpeg]
 * @property {import("sharp").JpegOptions} [jpg]
 * @property {import("sharp").PngOptions} [png]
 * @property {import("sharp").WebpOptions} [webp]
 */

/**
 * @typedef SharpFormat
 * @type {keyof SharpEncodeOptions}
 */

// TODO remove the `SizeSuffix` option in the next major release, because we support `[width]` and `[height]`
/**
 * @typedef SharpOptions
 * @type {object}
 * @property {ResizeOptions} [resize]
 * @property {number | 'auto'} [rotate]
 * @property {SizeSuffix} [sizeSuffix]
 * @property {SharpEncodeOptions} [encodeOptions]
 */

/**
 * @typedef SizeSuffix
 * @type {(width: number, height: number) => string}
 */

// https://github.com/lovell/sharp/blob/e40a881ab4a5e7b0e37ba17e31b3b186aef8cbf6/lib/output.js#L7-L23
const SHARP_GENERATE_FORMATS = new Map([
  ["avif", "avif"],
  ["gif", "gif"],
  ["heic", "heif"],
  ["heif", "heif"],
  ["j2c", "jp2"],
  ["j2k", "jp2"],
  ["jp2", "jp2"],
  ["jpeg", "jpeg"],
  ["jpg", "jpeg"],
  ["jpx", "jp2"],
  ["png", "png"],
  ["raw", "raw"],
  ["tif", "tiff"],
  ["tiff", "tiff"],
  ["webp", "webp"],
  ["svg", "svg"],
]);

const SHARP_MINIFY_FORMATS = new Map([
  ["avif", "avif"],
  ["gif", "gif"],
  ["heic", "heif"],
  ["heif", "heif"],
  ["j2c", "jp2"],
  ["j2k", "jp2"],
  ["jp2", "jp2"],
  ["jpeg", "jpeg"],
  ["jpg", "jpeg"],
  ["jpx", "jp2"],
  ["png", "png"],
  ["raw", "raw"],
  ["tif", "tiff"],
  ["tiff", "tiff"],
  ["webp", "webp"],
]);

/**
 * @param {WorkerResult} original
 * @param {SharpOptions} minimizerOptions
 * @param {SharpFormat | null} targetFormat
 * @returns {Promise<WorkerResult | null>}
 */
async function sharpTransform(
  original,
  minimizerOptions = {},
  targetFormat = null,
) {
  const inputExt = path.extname(original.filename).slice(1).toLowerCase();

  if (
    !targetFormat
      ? !SHARP_MINIFY_FORMATS.has(inputExt)
      : !SHARP_GENERATE_FORMATS.has(inputExt)
  ) {
    if (targetFormat) {
      const error = new Error(
        `Error with '${original.filename}': Input file has an unsupported format`,
      );

      original.errors.push(error);
    }

    return null;
  }

  /** @type {SharpLib} */
  // eslint-disable-next-line node/no-unpublished-require
  const sharp = require("sharp");
  const imagePipeline = sharp(original.data, { animated: true });

  // ====== rotate ======

  if (typeof minimizerOptions.rotate === "number") {
    imagePipeline.rotate(minimizerOptions.rotate);
  } else if (minimizerOptions.rotate === "auto") {
    imagePipeline.rotate();
  }

  // ====== resize ======

  if (minimizerOptions.resize) {
    const { enabled = true, unit = "px", ...params } = minimizerOptions.resize;

    if (
      enabled &&
      (typeof params.width === "number" || typeof params.height === "number")
    ) {
      if (unit === "percent") {
        const originalMetadata = await sharp(original.data).metadata();

        if (
          typeof params.width === "number" &&
          originalMetadata.width &&
          Number.isFinite(originalMetadata.width) &&
          originalMetadata.width > 0
        ) {
          params.width = Math.ceil(
            (originalMetadata.width * params.width) / 100,
          );
        }

        if (
          typeof params.height === "number" &&
          originalMetadata.height &&
          Number.isFinite(originalMetadata.height) &&
          originalMetadata.height > 0
        ) {
          params.height = Math.ceil(
            (originalMetadata.height * params.height) / 100,
          );
        }
      }

      imagePipeline.resize(params);
    }
  }

  // ====== convert ======

  const imageMetadata = await imagePipeline.metadata();

  const outputFormat =
    targetFormat ?? /** @type {SharpFormat} */ (imageMetadata.format);

  const encodeOptions = minimizerOptions.encodeOptions?.[outputFormat];

  imagePipeline.toFormat(outputFormat, encodeOptions);

  const result = await imagePipeline.toBuffer({ resolveWithObject: true });

  // ====== rename ======

  const outputExt = targetFormat ? outputFormat : inputExt;
  const { width, height } = result.info;

  const sizeSuffix =
    typeof minimizerOptions.sizeSuffix === "function"
      ? minimizerOptions.sizeSuffix(width, height)
      : "";

  const dotIndex = original.filename.lastIndexOf(".");
  const filename =
    dotIndex > -1
      ? `${original.filename.slice(0, dotIndex)}${sizeSuffix}.${outputExt}`
      : original.filename;

  // TODO use this then remove `sizeSuffix`
  // const filename = replaceFileExtension(original.filename, outputExt);

  const processedFlag = targetFormat ? "generated" : "minimized";
  const processedBy = targetFormat ? "generatedBy" : "minimizedBy";

  return {
    filename,
    data: result.data,
    warnings: [...original.warnings],
    errors: [...original.errors],
    info: {
      ...original.info,
      width,
      height,
      [processedFlag]: true,
      [processedBy]: ["sharp", ...(original.info?.[processedBy] ?? [])],
    },
  };
}

/**
 * @template T
 * @param {WorkerResult} original
 * @param {T} minimizerOptions
 * @returns {Promise<WorkerResult | null>}
 */
function sharpGenerate(original, minimizerOptions) {
  const sharpOptions = /** @type {SharpOptions} */ (minimizerOptions ?? {});

  const targetFormats = /** @type {SharpFormat[]} */ (
    Object.keys(sharpOptions.encodeOptions ?? {})
  );

  if (targetFormats.length === 0) {
    const error = new Error(
      `No result from 'sharp' for '${original.filename}', please configure the 'encodeOptions' option to generate images`,
    );

    original.errors.push(error);
    return Promise.resolve(null);
  }

  if (targetFormats.length > 1) {
    const error = new Error(
      `Multiple values for the 'encodeOptions' option is not supported for '${original.filename}', specify only one codec for the generator`,
    );

    original.errors.push(error);
    return Promise.resolve(null);
  }

  const [targetFormat] = targetFormats;

  return sharpTransform(original, sharpOptions, targetFormat);
}

/**
 * @template T
 * @param {WorkerResult} original
 * @param {T} minimizerOptions
 * @returns {Promise<WorkerResult | null>}
 */
function sharpMinify(original, minimizerOptions) {
  return sharpTransform(
    original,
    /** @type {SharpOptions} */ (minimizerOptions),
  );
}

/** @typedef {import("svgo")} SvgoLib */

/**
 * @typedef SvgoOptions
 * @type {object}
 * @property {SvgoEncodeOptions} [encodeOptions]
 */

/** @typedef {Omit<import("svgo").Config, "path" | "datauri">} SvgoEncodeOptions */

/**
 * @template T
 * @param {WorkerResult} original
 * @param {T} minimizerOptions
 * @returns {Promise<WorkerResult | null>}
 */
// eslint-disable-next-line require-await
async function svgoMinify(original, minimizerOptions) {
  if (path.extname(original.filename).toLowerCase() !== ".svg") {
    return null;
  }

  /** @type {SvgoLib} */
  // eslint-disable-next-line node/no-unpublished-require
  const { optimize } = require("svgo");
  const { encodeOptions } = /** @type {SvgoOptions} */ (minimizerOptions ?? {});

  /** @type {import("svgo").Output} */
  let result;

  try {
    result = optimize(original.data.toString(), {
      path: original.filename,
      ...encodeOptions,
    });
  } catch (error) {
    const originalError =
      error instanceof Error ? error : new Error(/** @type {string} */ (error));
    const newError = new Error(
      `Error with '${original.filename}': ${originalError.message}`,
    );

    original.errors.push(newError);
    return null;
  }

  return {
    filename: original.filename,
    data: Buffer.from(result.data),
    warnings: [...original.warnings],
    errors: [...original.errors],
    info: {
      ...original.info,
      minimized: true,
      minimizedBy: ["svgo", ...(original.info?.minimizedBy ?? [])],
    },
  };
}

/** @type {WeakMap<Module, AssetInfo>} */
const IMAGE_MINIMIZER_PLUGIN_INFO_MAPPINGS = new WeakMap();

module.exports = {
  throttleAll,
  isAbsoluteURL,
  replaceFileExtension,
  memoize,
  imageminNormalizeConfig,
  imageminMinify,
  imageminGenerate,
  squooshMinify,
  squooshGenerate,
  sharpMinify,
  sharpGenerate,
  svgoMinify,
  IMAGE_MINIMIZER_PLUGIN_INFO_MAPPINGS,
  ABSOLUTE_URL_REGEX,
  WINDOWS_PATH_REGEX,
};
