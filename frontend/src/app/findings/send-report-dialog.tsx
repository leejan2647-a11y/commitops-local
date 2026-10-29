import { LinkButton } from '@/components/ui/link-button'
export function SendReport({checkId}:{checkId:string}){return <LinkButton to={'/reports?check='+encodeURIComponent(checkId)}>Save report</LinkButton>}
