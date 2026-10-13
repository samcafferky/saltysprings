// Paste this into Fiddler Classic > FiddlerScript, then click "Save Script".
// It sends the game's Epic traffic to your OGFN server instead.
// Change 127.0.0.1:3551 if the server runs on another machine or port.
import Fiddler;

class Handlers
{
    static function OnBeforeRequest(oSession: Session) {
        if (oSession.hostname.Contains(".ol.epicgames.com")) {
            if (oSession.HTTPMethodIs("CONNECT")) {
                oSession["x-replywithtunnel"] = "OGFNTunnel";
                return;
            }
            oSession.fullUrl = "http://127.0.0.1:3551" + oSession.PathAndQuery;
        }
    }
}
