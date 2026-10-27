import { Temporal } from '@js-temporal/polyfill'
import { addDays, DEFAULT_TIME_ZONE, startOfWeek, todayDate } from '../domain/calendar'
import type { Account, Calendar, CalendarEvent } from '../domain/types'

export interface CalendarSnapshot {
  version: 1
  accounts: Account[]
  calendars: Calendar[]
  events: CalendarEvent[]
}

export function createDemoSnapshot(
  today = todayDate(),
  timeZone = DEFAULT_TIME_ZONE,
): CalendarSnapshot {
  const accounts: Account[] = [
    {
      id: 'personal',
      name: 'Alex Morgan',
      email: 'alex@example.com',
      initials: 'AM',
      color: '#1a73e8',
    },
    {
      id: 'work',
      name: 'Alex Morgan',
      email: 'alex@studio.example',
      initials: 'AM',
      color: '#0b8043',
    },
  ]
  const calendars: Calendar[] = [
    { id: 'personal', accountId: 'personal', name: 'Personal', color: '#1a73e8' },
    { id: 'family', accountId: 'personal', name: 'Family', color: '#f4511e' },
    { id: 'wellness', accountId: 'personal', name: 'Wellness', color: '#8e24aa' },
    { id: 'work', accountId: 'work', name: 'Work', color: '#0b8043' },
    { id: 'projects', accountId: 'work', name: 'Projects', color: '#d50000' },
  ]
  const events: CalendarEvent[] = []
  const week = startOfWeek(today)
  let sequence = 0
  function add(
    date: string,
    calendarId: string,
    title: string,
    hour: number,
    minute: number,
    duration: number,
    location = '',
    description = '',
  ) {
    const calendar = calendars.find((item) => item.id === calendarId)!
    const start = Temporal.PlainDate.from(date)
      .toPlainDateTime({ hour, minute })
      .toZonedDateTime(timeZone)
    events.push({
      id: `demo-${++sequence}`,
      accountId: calendar.accountId,
      calendarId,
      title,
      start: start.toInstant().toString(),
      end: start.add({ minutes: duration }).toInstant().toString(),
      allDay: false,
      timeZone,
      ...(location && { location }),
      ...(description && { description }),
    })
  }
  function allDay(date: string, calendarId: string, title: string, days = 1, description = '') {
    const calendar = calendars.find((item) => item.id === calendarId)!
    events.push({
      id: `demo-${++sequence}`,
      accountId: calendar.accountId,
      calendarId,
      title,
      start: date,
      end: addDays(date, days),
      allDay: true,
      timeZone,
      ...(description && { description }),
    })
  }

  for (let weekOffset = -2; weekOffset <= 2; weekOffset++) {
    const base = addDays(week, weekOffset * 7)
    for (let weekday = 1; weekday <= 5; weekday++) {
      const date = addDays(base, weekday)
      add(
        date,
        'work',
        'Team standup',
        9,
        0,
        30,
        'Google Meet',
        'Quick updates, priorities, and anything blocking the team.',
      )
      if (weekday === 1) {
        add(
          date,
          'work',
          'Weekly planning',
          10,
          0,
          60,
          'Studio · Room 2',
          'Review this week’s priorities and agree on the next milestones.',
        )
        add(
          date,
          'projects',
          'Website exploration',
          13,
          0,
          90,
          'Design studio',
          'Sketch directions for the new home page and bring two ideas to review.',
        )
        add(
          date,
          'family',
          'Grocery run',
          17,
          0,
          45,
          'Neighborhood market',
          'Pick up ingredients for the week.',
        )
      } else if (weekday === 2) {
        add(
          date,
          'projects',
          'Design review',
          10,
          0,
          60,
          'Google Meet',
          'Walk through the latest prototypes and capture feedback.',
        )
        add(
          date,
          'work',
          'Product sync',
          10,
          30,
          45,
          'Studio · Room 1',
          'Discuss upcoming releases and customer feedback.',
        )
        add(
          date,
          'personal',
          'Lunch with Jamie',
          12,
          30,
          60,
          'Little Finch Café',
          'Catch up over lunch.',
        )
        add(date, 'work', 'Focus time', 14, 0, 120, '', 'A quiet block for the proposal draft.')
        add(date, 'wellness', 'Evening walk', 17, 15, 45, 'Riverside trail')
      } else if (weekday === 3) {
        add(
          date,
          'work',
          'Customer discovery',
          10,
          0,
          60,
          'Google Meet',
          'Listen to how the team uses the new dashboard.',
        )
        add(
          date,
          'projects',
          'Prototype workshop',
          13,
          0,
          120,
          'Design studio',
          'Build and test the next version of the onboarding flow.',
        )
        add(date, 'wellness', 'Strength session', 16, 30, 60, 'Neighborhood gym')
      } else if (weekday === 4) {
        add(
          date,
          'projects',
          'Sprint planning',
          10,
          0,
          75,
          'Studio · Room 2',
          'Break down the next round of work and estimate together.',
        )
        add(
          date,
          'work',
          '1:1 with Taylor',
          11,
          0,
          30,
          'Google Meet',
          'Project check-in and time for questions.',
        )
        add(
          date,
          'work',
          'Writing & research',
          13,
          30,
          90,
          '',
          'Collect notes and prepare the project brief.',
        )
        add(date, 'family', 'Pick up Riley', 16, 0, 30, 'Community arts center')
      } else {
        add(
          date,
          'projects',
          'Project check-in',
          10,
          0,
          45,
          'Google Meet',
          'Review progress, demos, and next steps.',
        )
        add(date, 'work', 'Team lunch', 12, 0, 60, 'Studio kitchen')
        add(
          date,
          'work',
          'Weekly wrap-up',
          14,
          0,
          45,
          'Studio · Room 1',
          'Share wins and leave notes for next week.',
        )
        add(date, 'personal', 'Read & recharge', 16, 0, 60, 'Home')
      }
    }
    add(addDays(base, 6), 'family', 'Farmers market', 10, 0, 90, 'Town square')
    add(base, 'wellness', 'Slow Sunday', 10, 0, 60, 'Lakeside park')
    allDay(addDays(base, 2), 'personal', 'Library books due')
  }
  allDay(
    addDays(week, 1),
    'projects',
    'Launch week',
    5,
    'Final polish, team demos, and getting everything ready to share.',
  )
  allDay(
    addDays(week, 5),
    'family',
    'Weekend in the countryside',
    3,
    'Leave Friday evening. Remember the camera and walking shoes.',
  )
  allDay(addDays(week, 3), 'family', 'Sam’s birthday', 1, 'Call Sam after work!')
  return { version: 1, accounts, calendars, events }
}
