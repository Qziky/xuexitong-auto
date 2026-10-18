import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // The dedicated debug launcher owns Edge; WXT only builds and hot reloads.
  webExt: { disabled: true },
  dev: { server: { host: '127.0.0.1', port: 3000 } },
  manifest: {
    name: '超星课程任务助手',
    description:
      '浅色侧栏，按步骤识别文字、生成参考、核对、导出、填写及保存提交；支持音视频、文档、图片和章节题学习，实时显示进度。',
    version: '0.6.3',
    minimum_chrome_version: '116',
    permissions: [
      'storage',
      'alarms',
      'notifications',
      'sidePanel',
      'offscreen',
      'scripting',
      'tabs',
      'webNavigation',
    ],
    host_permissions: [
      'https://*.chaoxing.com/*',
      'https://api.xiaomimimo.com/*',
    ],
    optional_host_permissions: [
      'https://*/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
    ],
    action: { default_title: '打开课程任务助手' },
    icons: { 16: 'icon/16.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self';",
    },
  },
});
