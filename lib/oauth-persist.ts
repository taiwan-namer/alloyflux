/**
 * @deprecated 請改從 `@/lib/cloud-api` 匯入；此檔僅做相容 re-export。
 */
export {
  cloudApiBase,
  cloudDbProxy,
  cloudSourcesUrl,
  hasLocalDatabaseUrl,
  persistOAuthViaCloud,
  shouldProxyOAuthPersist,
  shouldProxyToCloudDb,
} from "./cloud-api";
