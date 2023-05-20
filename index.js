module.exports = function (app) {
  const logError =
    app.error ||
    (err => {
      console.error(err)
    })
  const debug =
    app.debug ||
    (msg => {
      console.log(msg)
    })

  const { find } = require('geo-tz')

  const fs = require('fs');

  var plugin = {
    unsubscribes: []
  }

  plugin.id = 'set-system-time'
  plugin.name = 'Set System Time'
  plugin.description =
    'Plugin that sets the system date & time from navigation.datetime delta messages'

  plugin.schema = () => ({
    title: 'Set System Time with sudo',
    type: 'object',
    properties: {
      interval: {
        type: 'number',
        title: 'Interval between updates in seconds (0 is once upon plugin start when datetime received)',
        default: 0
      },
      sudo: {
        type: 'boolean',
        title: 'Use sudo when setting the time',
        default: true
      },
      preferNetworkTime: {
        type: 'boolean',
        title: 'Set system time only if no other source are available ( Only chrony decteded )',
        default: true
      }
    }
  })

  const SUDO_NOT_AVAILABLE = 'SUDO_NOT_AVAILABLE'

  let count = 0
  let lastMessage = ''
  plugin.statusMessage = function () {
    return `${lastMessage} ${count > 0 ? '- system time set ' + count + ' times' : ''}`
  }

  plugin.start = function (options) {

    let stream = app.streambundle.getSelfStream('navigation.datetime')
    if (options && options.interval > 0) {
      stream = stream.debounceImmediate(options.interval * 1000)
    } else {
      stream = stream.take(1)
    }
    plugin.unsubscribes.push(
      stream.onValue(function (datetime) {
        var child
        if (process.platform == 'win32') {
          console.error("Set-system-time supports only linux-like os's")
        } else {
          if( ! plugin.useNetworkTime(options) ){
            const useSudo = typeof options.sudo === 'undefined' || options.sudo
            const setDate = `date --iso-8601 -u -s "${datetime}"`
            const command = useSudo
              ? `if sudo -n date &> /dev/null ; then sudo ${setDate} ; else exit 3 ; fi`
              : setDate
            child = require('child_process').spawn('sh', ['-c', command])
            child.on('exit', value => {
              if (value === 0) {
                count++
                lastMessage = 'System time set to ' + datetime
                debug(lastMessage)
              } else if (value === 3) {
                lastMessage =
                  'Passwordless sudo not available, can not set system time'
                logError(lastMessage)
              }
            })
            child.stderr.on('data', function (data) {
              lastMessage = data.toString()
              logError(lastMessage)
            })
          }
        }
      })
    )
    
    //lookup our current timezone
    try {
      var current_timezone = fs.readFileSync('/etc/timezone', 'utf8');
      current_timezone = current_timezone.trim();
      app.debug("Current timezone: " + current_timezone);
    } catch (err) {
      app.error(err);
    }
    
    //get our position update every 10 minutes
    let localSubscription = {
      context: 'vessels.self',
      subscribe: [
        {
          path: 'navigation.position',
          period: 36000
        }
      ]
    }
    
    //loop through each update and look up the timezone
    app.subscriptionmanager.subscribe(
      localSubscription,
      plugin.unsubscribes,
      subscriptionError => {
        app.error('Error:' + subscriptionError);
      },
      delta => {
        delta.updates.forEach(u => {
          
          let lat = u.values[0].value.latitude
          let lon = u.values[0].value.longitude

          //look up our timezone
          let tzinfo = find(lat, lon)
          if (Array.isArray(tzinfo) && tzinfo.length > 0) {
            timezone = tzinfo[0].toString()
            app.debug("Timezone: "+ timezone)
            let updates = {
              updates: [
                {
                  values: [
                    {
                      path: 'navigation.timezone',
                      value: timezone
                    }
                  ]
                }
              ]
            }
            app.handleMessage(plugin.id, updates)
            
            //has it changed?
            if (timezone != current_timezone) {
              app.debug("New timezone!")
              
              var command = `sudo timedatectl set-timezone ${timezone}`
              app.debug(command)
              var child
              child = require('child_process').spawn('sh', ['-c', command])
              child.on('exit', value => {
                if (value === 0) {
                  count++
                  lastMessage = 'Timezone set to ' + timezone
                  debug(lastMessage)
                } else if (value === 3) {
                  lastMessage =
                    'Passwordless sudo not available, cannot set timezone'
                  logError(lastMessage)
                }
              })
              child.stderr.on('data', function (data) {
                lastMessage = data.toString()
                logError(lastMessage)
              })
              
              command = "sudo /etc/init.d/cron restart"
              app.debug(command)
              child = require('child_process').spawn('sh', ['-c', command])
              child.on('exit', value => {
                if (value === 0) {
                  count++
                  lastMessage = 'Restarted cron'
                  debug(lastMessage)
                } else if (value === 3) {
                  lastMessage =
                    'Passwordless sudo not available, cannot restart cron'
                  logError(lastMessage)
                }
              })
              child.stderr.on('data', function (data) {
                lastMessage = data.toString()
                logError(lastMessage)
              })          
          
              current_timezone = timezone
            }
          }
        })
      }
    )
  }

  plugin.useNetworkTime = (options) => {
    if ( typeof options.preferNetworkTime !== 'undefined' && options.preferNetworkTime == true ){
      const chronyCmd = "chronyc sources 2> /dev/null | cut -c2 | grep -ce '-\|*'";
      try {
        validSources = require('child_process').execSync(chronyCmd,{timeout:500});
      } catch (e) {
        return false
      }
      if(validSources > 0 ){
        return true
      }
    }
    return false
  }

  plugin.stop = function () {
    plugin.unsubscribes.forEach(f => f())
  }

  return plugin
}
