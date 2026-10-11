export const safeStorage = {}
export const app = { getPath: () => process.env.AXORA_TEST_HOME ?? '/tmp', getVersion: () => '0.1.0-test', isPackaged: false }
export const dialog = {}
export const shell = { openPath: async () => '' }
export const Notification = { isSupported: () => false }
