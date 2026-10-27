import type { RecurrenceRule } from '../domain/recurrence'
import { WEEKDAYS } from '../domain/recurrence'

export function RecurrenceControls({
  rule,
  onChange,
  disabled,
}: {
  rule: RecurrenceRule | null
  onChange: (rule: RecurrenceRule) => void
  disabled: boolean
}) {
  if (!rule)
    return (
      <p className="settings-help">
        This imported recurrence pattern is preserved. Open Google Calendar to change its schedule.
      </p>
    )
  return (
    <fieldset className="recurrence-controls" disabled={disabled}>
      <label>
        Repeats
        <select
          aria-label="Repeats"
          value={rule.frequency}
          onChange={(e) =>
            onChange({ ...rule, frequency: e.target.value as RecurrenceRule['frequency'] })
          }
        >
          <option value="none">Does not repeat</option>
          <option value="DAILY">Daily</option>
          <option value="WEEKLY">Weekly</option>
          <option value="MONTHLY">Monthly by date</option>
          <option value="YEARLY">Yearly by month and date</option>
        </select>
      </label>
      {rule.frequency !== 'none' && (
        <>
          <label>
            Every
            <input
              aria-label="Repeat interval"
              type="number"
              min={1}
              max={999}
              value={rule.interval}
              onChange={(e) => onChange({ ...rule, interval: Number(e.target.value) })}
            />
          </label>
          {rule.frequency === 'WEEKLY' && (
            <div className="recurrence-weekdays">
              {WEEKDAYS.map((day, index) => (
                <label key={day}>
                  <input
                    type="checkbox"
                    aria-label={`Repeat on ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][index]}`}
                    checked={rule.weekdays.includes(day)}
                    onChange={(e) =>
                      onChange({
                        ...rule,
                        weekdays: e.target.checked
                          ? [...rule.weekdays, day]
                          : rule.weekdays.filter((v) => v !== day),
                      })
                    }
                  />
                  {day}
                </label>
              ))}
            </div>
          )}
          <label>
            Ends
            <select
              aria-label="Repeat ending"
              value={rule.ending}
              onChange={(e) =>
                onChange({ ...rule, ending: e.target.value as RecurrenceRule['ending'] })
              }
            >
              <option value="never">Never</option>
              <option value="count">After a count</option>
              <option value="until">On a date</option>
            </select>
          </label>
          {rule.ending === 'count' && (
            <label>
              Occurrences
              <input
                aria-label="Occurrence count"
                type="number"
                min={1}
                max={9999}
                value={rule.count}
                onChange={(e) => onChange({ ...rule, count: Number(e.target.value) })}
              />
            </label>
          )}
          {rule.ending === 'until' && (
            <label>
              Until
              <input
                aria-label="Repeat until"
                type="date"
                value={rule.until}
                onChange={(e) => onChange({ ...rule, until: e.target.value })}
              />
            </label>
          )}
          {['MONTHLY', 'YEARLY'].includes(rule.frequency) && (
            <p className="settings-help">
              Google skips dates that do not exist in a month or year.
            </p>
          )}
        </>
      )}
    </fieldset>
  )
}
