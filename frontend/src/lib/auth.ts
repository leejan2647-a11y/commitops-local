export async function getAccessToken(){return document.querySelector<HTMLMetaElement>('meta[name=local-session]')?.content??''}
