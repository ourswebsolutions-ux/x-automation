import { Compass, LayoutDashboard } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router'
import { Button, EmptyState } from '@/components/ui'

export function NotFoundPage() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  return (
    <EmptyState
      icon={Compass}
      title="This page doesn't exist"
      description={<>Nothing lives at <code className="font-mono text-xs text-fg-muted">{pathname}</code>.</>}
      actions={
        <Button variant="primary" icon={LayoutDashboard} onClick={() => navigate('/dashboard')}>
          Go to dashboard
        </Button>
      }
      className="min-h-[60vh]"
    />
  )
}
