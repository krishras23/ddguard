/**
 * @typedef {Object} Monitor
 * @property {string} address
 * @property {string} name
 * @property {string} type
 * @property {string} query
 * @property {string} message
 * @property {string[]} tags
 * @property {number|null} priority
 * @property {{critical:number|null, critical_recovery:number|null, warning:number|null, warning_recovery:number|null}} thresholds
 * @property {boolean} notify_no_data
 * @property {number|null} no_data_timeframe
 * @property {number|null} new_group_delay
 * @property {number|null} evaluation_delay
 * @property {boolean} require_full_window
 * @property {string|null} on_missing_data
 * @property {"create"|"update"} action
 */

/**
 * @typedef {Object} ParsedQuery
 * @property {string} raw
 * @property {string} timeAggregator
 * @property {number} windowSeconds
 * @property {string} spaceAggregator
 * @property {string} metric
 * @property {Object<string,string>} scope
 * @property {string[]} groupBy
 * @property {string[]} modifiers
 * @property {string} operator
 * @property {number} threshold
 * @property {string} dataQuery
 */

/**
 * @typedef {Object} Finding
 * @property {string} monitor
 * @property {string} check
 * @property {"fail"|"warn"|"pass"} level
 * @property {string} code
 * @property {string} message
 * @property {string} [detail]
 * @property {string} [suggestion]
 */

module.exports = {};
