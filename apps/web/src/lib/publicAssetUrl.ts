const publicBaseUrl = import.meta.env.BASE_URL.replace(/\/?$/, "/");

export function publicAssetUrl(path: string): string {
  return `${publicBaseUrl}${path.replace(/^\//, "")}`;
}
