'use strict';
// Runs after electron-builder packs the app — used for post-pack verification
exports.default = async function (context) {
    console.log('[after-pack] Pack complete for platform:', context.electronPlatformName);
};
