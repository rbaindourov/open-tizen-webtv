# Samsung Smart Hub Preview (`bg_service`) & Deep-Linking Guide

Samsung Smart TVs support a home launcher ribbon ("Smart Hub Preview") that displays playable content tiles when a user highlights your application icon on the TV home screen.

---

## 1. Required `src/config.xml` Declarations

In [`src/config.xml`](../src/config.xml):

1. **Deep-Link App Control**: Allows the TV launcher to pass deep-link `action_data` parameters into your foreground web app without forcing a full page reload (`reload="disable"`):
   ```xml
   <tizen:app-control>
       <tizen:src name="index.html" reload="disable"></tizen:src>
       <tizen:operation name="http://tizen.org/appcontrol/operation/view"></tizen:operation>
   </tizen:app-control>
   ```
2. **Background Service Registration**:
   ```xml
   <tizen:service id="OSWebTVApp.service">
       <tizen:content src="service/service.js"/>
       <tizen:name>OpenWebTVPreviewService</tizen:name>
       <tizen:description>Smart Hub Preview Background Service</tizen:description>
       <tizen:category name="http://tizen.org/category/service"/>
   </tizen:service>
   ```
3. **Preview Metadata**:
   ```xml
   <tizen:metadata key="http://samsung.com/tv/metadata/devel.api.version" value="2.4"/>
   <tizen:metadata key="http://samsung.com/tv/metadata/use.preview" value="bg_service"/>
   <tizen:metadata key="http://samsung.com/tv/metadata/prelaunch.support" value="true"/>
   ```

---

## 2. Handling Deep-Link Launches in Your Web App

When a user clicks a tile in the Smart Hub Preview bar (for example, `"action_data": "watch/open-big-buck-bunny"`), Samsung Tizen fires an `appcontrol` event on `window`. [`OpenWebTVPlayer.extractDeepLinkFromEnvironment()`](../dev-server/public/player.js) handles this automatically:

```javascript
function checkDeepLinkPayload() {
  if (typeof tizen === 'undefined' || !tizen.application) {
    return null;
  }
  var reqAppControl = tizen.application.getCurrentApplication().getRequestedAppControl();
  if (!reqAppControl || !reqAppControl.appControl || !reqAppControl.appControl.data) {
    return null;
  }
  var data = reqAppControl.appControl.data;
  for (var i = 0; i < data.length; i++) {
    if (data[i].key === 'PAYLOAD' && data[i].value && data[i].value.length > 0) {
      try {
        var parsed = JSON.parse(data[i].value[0]);
        return parsed.values; // e.g. "watch/open-big-buck-bunny"
      } catch (e) {
        return data[i].value[0];
      }
    }
  }
  return null;
}
```
