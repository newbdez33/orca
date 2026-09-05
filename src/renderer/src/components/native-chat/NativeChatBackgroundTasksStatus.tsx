import { AgentStateDot } from '@/components/AgentStateDot'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export function NativeChatBackgroundTasksStatus(props: {
  stopping: boolean
  onStop: () => void
}): React.JSX.Element {
  return (
    <div
      data-native-chat-background-tasks="true"
      className="shrink-0 bg-background px-3 pt-2 sm:px-4"
    >
      <div className="mx-auto flex h-8 w-full max-w-4xl items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 text-xs text-muted-foreground shadow-xs">
        <span aria-hidden="true">
          <AgentStateDot state="monitoring" size="md" title={null} />
        </span>
        <span>
          {translate(
            'components.native-chat.backgroundTasks.monitoring',
            'Monitoring background tasks'
          )}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="ml-auto"
          disabled={props.stopping}
          onClick={props.onStop}
        >
          {translate('components.native-chat.backgroundTasks.stop', 'Stop')}
        </Button>
      </div>
    </div>
  )
}
