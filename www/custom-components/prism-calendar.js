
class PrismCalendarCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._events = [];
    this._loading = false;
    this._lastFetch = 0;
  }

  static getStubConfig() {
    return { 
      entity_1: "calendar.example", 
      color_1: "#f87171",
      max_events: 5,
      icon_color: "#f87171"
    }
  }

  static getConfigForm() {
    return {
      schema: [
        {
          name: "",
          type: "expandable",
          title: "Kalender 1 (Hauptkalender)",
          icon: "mdi:calendar",
          schema: [
            {
              name: "entity_1",
              required: true,
              selector: { entity: { domain: "calendar" } }
            },
            {
              name: "color_1",
              selector: { color_rgb: {} }
            }
          ]
        },
        {
          name: "",
          type: "expandable",
          title: "Kalender 2 (Optional)",
          icon: "mdi:calendar-plus",
          schema: [
            {
              name: "entity_2",
              selector: { entity: { domain: "calendar" } }
            },
            {
              name: "color_2",
              selector: { color_rgb: {} }
            }
          ]
        },
        {
          name: "",
          type: "expandable",
          title: "Kalender 3 (Optional)",
          icon: "mdi:calendar-plus",
          schema: [
            {
              name: "entity_3",
              selector: { entity: { domain: "calendar" } }
            },
            {
              name: "color_3",
              selector: { color_rgb: {} }
            }
          ]
        },
        {
          name: "",
          type: "expandable",
          title: "Allgemeine Einstellungen",
          icon: "mdi:cog",
          schema: [
            {
              name: "max_events",
              selector: { number: { min: 1, max: 10, step: 1, mode: "box" } }
            },
            {
              name: "icon_color",
              selector: { color_rgb: {} }
            }
          ]
        }
      ]
    };
  }

  setConfig(config) {
    // Support both old (entity) and new (entity_1) config formats
    const entity1 = config.entity_1 || config.entity;
    if (!entity1) {
      throw new Error('Please define at least one calendar entity (entity_1)');
    }
    
    // Create a copy to avoid modifying read-only config object
    this.config = { ...config };
    
    // Migrate old config format
    if (config.entity && !config.entity_1) {
      this.config.entity_1 = config.entity;
    }
    if (config.dot_color && !config.color_1) {
      this.config.color_1 = config.dot_color;
    }
    
    // Set defaults
    if (!this.config.max_events) {
      this.config.max_events = 5;
    }
    
    // Normalize colors (convert RGB arrays to hex if needed)
    if (this.config.icon_color) {
      this.config.icon_color = this._normalizeColor(this.config.icon_color);
    } else {
      this.config.icon_color = "#f87171";
    }
    
    // Normalize calendar colors with defaults
    this.config.color_1 = this._normalizeColor(this.config.color_1) || "#f87171";
    this.config.color_2 = this._normalizeColor(this.config.color_2) || "#60a5fa";
    this.config.color_3 = this._normalizeColor(this.config.color_3) || "#4ade80";
    
    this._events = [];
    this.render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this.config && this.config.entity_1) {
      // Fetch calendar events every 60 seconds or on first load
      const now = Date.now();
      if (now - this._lastFetch > 60000) {
        this._fetchCalendarEvents();
      } else {
        this.render();
      }
    }
  }

  async _fetchCalendarEvents() {
    if (!this._hass || !this.config.entity_1 || this._loading) return;
    
    this._loading = true;
    this._lastFetch = Date.now();
    
    try {
      // Calculate date range: now to 30 days in the future
      const now = new Date();
      const startDate = now.toISOString();
      const endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
      
      // Collect all configured calendars
      const calendars = [];
      if (this.config.entity_1) {
        calendars.push({ entity: this.config.entity_1, color: this.config.color_1 });
      }
      if (this.config.entity_2) {
        calendars.push({ entity: this.config.entity_2, color: this.config.color_2 });
      }
      if (this.config.entity_3) {
        calendars.push({ entity: this.config.entity_3, color: this.config.color_3 });
      }
      
      // Fetch events from all calendars in parallel using HA's built-in methods
      const fetchPromises = calendars.map(async (cal) => {
        try {
          let eventsArray = [];
          
          // Method 1: Try callApi (REST API with automatic auth)
          try {
            eventsArray = await this._hass.callApi(
              'GET',
              `calendars/${cal.entity}?start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`
            );
          } catch (apiError) {
            console.debug(`Prism Calendar: callApi failed for ${cal.entity}, trying WebSocket...`, apiError);
            
            // Method 2: Fallback to WebSocket
            try {
              const wsResult = await this._hass.callWS({
                type: 'calendar/events',
                entity_id: cal.entity,
                start_date_time: startDate,
                end_date_time: endDate
              });
              eventsArray = wsResult?.events || wsResult || [];
            } catch (wsError) {
              console.warn(`Prism Calendar: WebSocket also failed for ${cal.entity}:`, wsError);
              return [];
            }
          }
          
          if (Array.isArray(eventsArray) && eventsArray.length > 0) {
            return eventsArray.map(event => {
              const title = event.summary || event.title || event.message || this._t('untitled');
              const start = event.start?.dateTime || event.start?.date || event.start;
              const end = event.end?.dateTime || event.end?.date || event.end;
              
              return { 
                title, 
                start, 
                end, 
                calendarEntity: cal.entity,
                calendarColor: cal.color 
              };
            });
          }
          return [];
        } catch (error) {
          console.warn(`Prism Calendar: Error fetching ${cal.entity}:`, error);
          return [];
        }
      });
      
      // Wait for all fetches to complete
      const allEventsArrays = await Promise.all(fetchPromises);
      
      // Combine all events from all calendars
      const allEvents = allEventsArrays.flat();
      
      // Sort by start date and limit to max_events
      this._events = allEvents
        .filter(event => event.start)
        .sort((a, b) => {
          const dateA = new Date(a.start);
          const dateB = new Date(b.start);
          return dateA - dateB;
        })
        .slice(0, this.config.max_events || 5);
      
      // Fallback to entity attributes if no events found via API
      if (this._events.length === 0 && this.config.entity_1) {
        console.debug('Prism Calendar: No events from API, trying entity attributes fallback...');
        const entity = this._hass.states[this.config.entity_1];
        if (entity && entity.attributes) {
          const attr = entity.attributes;
          if (attr.message && attr.start_time) {
            this._events = [{
              title: attr.message,
              start: attr.start_time,
              end: attr.end_time || attr.start_time,
              calendarEntity: this.config.entity_1,
              calendarColor: this.config.color_1
            }];
            console.debug('Prism Calendar: Using entity attribute fallback (1 event)');
          }
        }
      }
      
    } catch (error) {
      console.warn('Prism Calendar: Could not fetch calendar events:', error);
      this._events = [];
    }
    
    this._loading = false;
    this.render();
  }

  getCardSize() {
    return 3;
  }

  connectedCallback() {
    if (this.config) {
      this.render();
    }
  }

  // Translation helper - English default, German if HA is set to German
  _t(key) {
    const lang = this._hass?.language || this._hass?.locale?.language || 'en';
    const isGerman = lang.startsWith('de');
    
    const translations = {
      'loading': isGerman ? 'Lade Termine...' : 'Loading events...',
      'no_events': isGerman ? 'Keine kommenden Termine' : 'No upcoming events',
      'no_more_events': isGerman ? 'Keine weiteren Termine' : 'No more events',
      'all_day': isGerman ? 'Ganztägig' : 'All day',
      'today': isGerman ? 'Heute' : 'Today',
      'tomorrow': isGerman ? 'Morgen' : 'Tomorrow',
      'all_day_suffix': isGerman ? '(ganztägig)' : '(all day)',
      'calendar': isGerman ? 'Kalender' : 'Calendar',
      'events': isGerman ? 'Termine' : 'Events',
      'next_event': isGerman ? 'Nächstes Event' : 'Next Event',
      'untitled': isGerman ? 'Unbenannt' : 'Untitled'
    };
    
    return translations[key] || key;
  }

  // Get locale for date/time formatting
  _getLocale() {
    const lang = this._hass?.language || this._hass?.locale?.language || 'en';
    return lang.startsWith('de') ? 'de-DE' : 'en-US';
  }

  render() {
    if (!this.config || !this.config.entity_1) return;
    
    const maxEvents = this.config.max_events || 5;
    const iconColor = this._normalizeColor(this.config.icon_color || "#f87171");
    const locale = this._getLocale();
    
    // Use fetched events
    const events = this._events.slice(0, maxEvents);
    
    // Generate event items
    let eventItems = '';
    if (events.length === 0) {
      // No events or still loading
      eventItems = `
        <div class="event-item" style="opacity: 0.6;">
          <div class="timeline">
            <div class="dot"></div>
          </div>
          <div class="event-info">
            <div class="event-title">${this._loading ? this._t('loading') : this._t('no_events')}</div>
            <div class="event-time">
              <ha-icon icon="mdi:clock-outline" style="--mdc-icon-size: 12px;"></ha-icon>
              -
            </div>
          </div>
        </div>
      `;
    } else {
      events.forEach((event, i) => {
        const isActive = i === 0;
        const dotColor = event.calendarColor || this.config.color_1;
        let timeStr = this._t('all_day');
        
        if (event.start) {
          try {
            const date = new Date(event.start);
            if (!isNaN(date.getTime())) {
              const now = new Date();
              const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
              const eventDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
              
              // Check if it's an all-day event (no time component or midnight)
              const isAllDay = event.start.length === 10 || (date.getHours() === 0 && date.getMinutes() === 0);
              
              if (eventDate.getTime() === today.getTime()) {
                // Today
                timeStr = isAllDay ? `${this._t('today')} ${this._t('all_day_suffix')}` : `${this._t('today')}, ${date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`;
              } else {
                // Future date
                const daysDiff = Math.floor((eventDate - today) / (1000 * 60 * 60 * 24));
                if (daysDiff === 1) {
                  timeStr = isAllDay ? `${this._t('tomorrow')} ${this._t('all_day_suffix')}` : `${this._t('tomorrow')}, ${date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`;
                } else if (daysDiff > 1 && daysDiff <= 7) {
                  timeStr = isAllDay 
                    ? date.toLocaleDateString(locale, { weekday: 'long' }) + ' ' + this._t('all_day_suffix')
                    : date.toLocaleDateString(locale, { weekday: 'short' }) + ', ' + date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
                } else {
                  timeStr = isAllDay
                    ? date.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' }) + ' ' + this._t('all_day_suffix')
                    : date.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' }) + ', ' + date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
                }
              }
            }
          } catch (e) {
            // If date parsing fails, keep default "All day"
          }
        }
        
        // Dot styling: filled for active event, subtle border for others
        const dotStyle = isActive 
          ? `background: ${dotColor}; box-shadow: 0 0 8px ${dotColor}99;`
          : `background: transparent; border: 2px solid ${this._hexToRgba(dotColor, 0.4)};`;
        
        eventItems += `
          <div class="event-item" style="opacity: ${isActive ? '1' : '0.8'};">
            <div class="timeline">
              <div class="dot ${isActive ? 'active' : 'bordered'}" style="${dotStyle}"></div>
            </div>
            <div class="event-info">
              <div class="event-title">${event.title}</div>
              <div class="event-time">
                <ha-icon icon="mdi:clock-outline" style="--mdc-icon-size: 12px;"></ha-icon>
                ${timeStr}
              </div>
            </div>
          </div>
        `;
      });
      
      // Fill remaining slots with placeholders if needed
      for (let i = events.length; i < maxEvents; i++) {
        eventItems += `
          <div class="event-item" style="opacity: 0.4;">
            <div class="timeline">
              <div class="dot"></div>
            </div>
            <div class="event-info">
              <div class="event-title">${this._t('no_more_events')}</div>
              <div class="event-time">
                <ha-icon icon="mdi:clock-outline" style="--mdc-icon-size: 12px;"></ha-icon>
                -
              </div>
            </div>
          </div>
        `;
      }
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, -apple-system, sans-serif;
        }
        .card {
          background: rgba(30, 32, 36, 0.6);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.05);
          border-top: 1px solid rgba(255, 255, 255, 0.15);
          border-bottom: 1px solid rgba(0, 0, 0, 0.4);
          box-shadow: 0 10px 20px -5px rgba(0, 0, 0, 0.5), 0 2px 4px rgba(0,0,0,0.3);
          padding: 20px;
          color: white;
        }
        
        .header {
            display: flex; gap: 12px; align-items: center; margin-bottom: 24px;
        }
        .icon-box {
            width: 40px; height: 40px; min-width: 40px; min-height: 40px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            background: linear-gradient(145deg, rgba(25, 27, 30, 1), rgba(30, 32, 38, 1));
            box-shadow: inset 3px 3px 8px rgba(0, 0, 0, 0.7), inset -2px -2px 4px rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.05);
            flex-shrink: 0;
        }
        .icon-box ha-icon {
            width: 22px; height: 22px; --mdc-icon-size: 22px;
            filter: drop-shadow(0 0 6px currentColor);
        }
        .title { font-size: 1.125rem; font-weight: 700; color: rgba(255, 255, 255, 0.9); line-height: 1; }
        .subtitle { font-size: 0.75rem; font-weight: 500; color: rgba(255, 255, 255, 0.6); text-transform: uppercase; margin-top: 4px; letter-spacing: 0.05em; }
        
        .event-list {
            display: flex; flex-direction: column; gap: 12px;
        }
        .event-item {
            display: flex; gap: 16px; align-items: center;
            background: rgba(20, 20, 20, 0.4);
            box-shadow: inset 2px 2px 5px rgba(0,0,0,0.5), inset -1px -1px 2px rgba(255,255,255,0.05);
            border-radius: 12px;
            padding: 12px 16px;
            border: 1px solid rgba(255,255,255,0.02);
        }
        .timeline {
            display: flex; flex-direction: column; align-items: center; justify-content: center; width: 42px; flex-shrink: 0;
            margin-left: 1px; /* Precise alignment adjustment */
        }
        /* Visual alignment helper: The header icon is 42px wide. We want these dots centered relative to that column */
        
        .dot {
            width: 10px; height: 10px; border-radius: 50%; background: rgba(255,255,255,0.2);
            box-sizing: border-box;
        }
        .dot.active {
            /* Color set inline */
        }
        .dot.bordered {
            width: 10px; height: 10px;
            /* Border and color set inline */
        }
        
        .event-info {
            flex: 1;
        }
        .event-title { font-size: 15px; font-weight: 500; color: white; margin-bottom: 4px; }
        .event-time { font-size: 12px; color: rgba(255,255,255,0.5); display: flex; align-items: center; gap: 6px; }
        
        /* Responsive: Compact spacing for tablets and mobile */
        @media (max-width: 1024px) {
            .timeline {
                width: 22px;
                margin-left: 0px;
            }
            .event-item {
                gap: 8px;
            }
        }
        
      </style>
      <div class="card">
        <div class="header">
            <div class="icon-box" style="background: ${this._hexToRgba(iconColor, 0.15)}; color: ${iconColor};">
                <ha-icon icon="mdi:calendar"></ha-icon>
            </div>
            <div>
                <div class="title">${this._t('calendar')}</div>
                <div class="subtitle">${events.length > 0 ? `${events.length} ${this._t('events')}` : this._t('next_event')}</div>
            </div>
        </div>
        
        <div class="event-list">
            ${eventItems}
        </div>
      </div>
    `;
  }

  _normalizeColor(color) {
    if (!color) return null;
    // If color is an array [r, g, b] from color_rgb selector, convert to hex
    if (Array.isArray(color) && color.length >= 3) {
      const r = color[0].toString(16).padStart(2, '0');
      const g = color[1].toString(16).padStart(2, '0');
      const b = color[2].toString(16).padStart(2, '0');
      return `#${r}${g}${b}`;
    }
    // If it's already a hex string, return as is
    return color;
  }

  _hexToRgba(hex, alpha) {
    if (!hex || !hex.startsWith('#')) return `rgba(248, 113, 113, ${alpha})`;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
}

customElements.define('prism-calendar', PrismCalendarCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "prism-calendar",
  name: "Prism Calendar",
  preview: true,
  description: "A custom calendar card supporting up to 3 calendars with individual colors"
});
