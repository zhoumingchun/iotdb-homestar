/*
 *  things.js
 *
 *  David Janes
 *  IOTDB.org
 *  2015-01-08
 *
 *  Copyright [2013-2015] [David P. Janes]
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

"use strict";

var iotdb = require('iotdb');
var _ = iotdb.helpers;
var cfg = iotdb.cfg;

var path = require('path');

var mqtt = require('./mqtt');
var settings = require('./settings');
var helpers = require('./helpers');
var interactors = require('./interactors');

var MQTTTransport = require('iotdb-transport-mqtt').Transport;
var ExpressTransport = require('iotdb-transport-express').Transport;
var IOTDBTransport = require('iotdb-transport-iotdb').Transport;
var FSTransport = require('iotdb-transport-fs').Transport;

var logger = iotdb.logger({
    name: 'iotdb-homestar',
    module: 'app/things',
});

/**
 *  Returns a Thing by thing_id
 */
var _thing_by_id = function (thing_id) {
    var iot = iotdb.iot();
    var things = iot.things();
    for (var ti = 0; ti < things.length; ti++) {
        var t = things[ti];
        if (t.thing_id() === thing_id) {
            return t;
        }
    }

    console.log("# _thing_by_id: thing not found", thing_id);
    return null;
};

var scrub_id = function (v) {
    if (!v) {
        return "";
    } else {
        return v.replace(/.*#/, '');
    }
};

var structured = {};

/**
 *  Clean up the structure. You can do this whenever
 *  you want - it will be rebuilt when need in
 *  _structure_thing. Specifically, you'll want to
 *  clear structures when the metadata changes.
 */
var _clear_structure = function (thing) {
    if (thing === undefined) {
        structured = {};
    } else {
        structured[thing.thing_id()] = undefined;
    }
};

/*
 *  Preprocess attributes
 *  - compact everything
 *  - find out if control or reading attibute
 */
var _structure_thing = function (thing) {
    var s = structured[thing.thing_id()];
    if (s) {
        return s;
    }

    var cid;
    var cat;

    var meta = thing.meta();
    var thing_name = meta.get('schema:name') || thing.name;

    /*
     *  Do initial pre-processing on attributes
     */
    var catd = {};
    var tats = thing.attributes();
    for (var tax in tats) {
        var tat = tats[tax];

        cat = _.ld.compact(tat);
        cat._code = tat.get_code();

        var name = _.ld.first(cat, 'schema:name');
        cat['@id'] = "/api/things/" + thing.thing_id() + "/#" + cat._code;
        cat._name = name || cat._code;
        cat._thing_id = thing.thing_id();
        cat._thing_name = thing_name;
        cat._thing_group = thing_name + "@@" + thing.thing_id();
        cat._id = thing.thing_id() + "/#" + cat._code;
        cat.group = thing_name;

        cid = scrub_id(_.ld.first(cat, "@id", ""));
        if (_.ld.list(cat, 'iot:role') === undefined) {
            cat._out = cid;
            cat._in = cid;
        }
        if (_.ld.contains(cat, 'iot:role', 'iot-attribute:role-control')) {
            cat._out = cid;
        }
        if (_.ld.contains(cat, 'iot:role', 'iot-attribute:role-reading')) {
            cat._in = cid;
        }

        catd[cid] = cat;
    }

    /**
     *  Group related control/reading attributes together
     */
    for (cid in catd) {
        cat = catd[cid];
        if (cat._use === undefined) {
            cat._use = true;
        }

        var rids = _.ld.list(cat, "iot:related-role", []);
        for (var rix in rids) {
            var rid = scrub_id(rids[rix]);
            var rat = catd[rid];
            if (rat === undefined) {
                continue;
            }

            if (rat._use === undefined) {
                rat._use = false;
            }
            if (cat._out && !rat._out) {
                rat._out = cat._out;
            }
            if (cat._in && !rat._in) {
                rat._in = cat._in;
            }
        }

    }

    var cats = [];
    for (var ci in catd) {
        cat = catd[ci];
        if (!cat._use) {
            continue;
        }

        cats.push(cat);
    }

    s = {
        thing_id: thing.thing_id(),
        cats: cats
    };
    structured[thing.thing_id()] = s;

    return s;
};


var structured = function () {
    var things = iotdb.iot().things();
    var thing;
    var ti;

    // order things by thing_name first
    var tts = [];
    for (ti = 0; ti < things.length; ti++) {
        thing = things[ti];
        var meta = thing.meta();
        var thing_name = meta.get('schema:name') || thing.name;
        if (thing_name === undefined) {
            continue;
        }

        tts.push([thing_name, thing]);
    }

    tts.sort();

    // then get all the compressed attributes
    var cats = [];
    for (ti in tts) {
        var tt = tts[ti];
        thing = tt[1];
        var state = thing.state();
        var s = _structure_thing(thing);

        for (var ci in s.cats) {
            var cat = s.cats[ci];
            cat.state = state;

            cats.push(cat);
        }
    }

    return cats;
};

var _make_thing = function (f) {
    return function (request, response) {
        logger.info({
            method: "_make_thing",
            recipe_id: request.params.thing_id,
            body: request.body,
        }, "called");

        var thing = _thing_by_id(request.params.thing_id);
        if (!thing) {
            return response
                .set('Content-Type', 'application/json')
                .status(404)
                .send(JSON.stringify({
                    error: "thing not found",
                    thing_id: request.params.thing_id
                }, null, 2));
        }

        response.set('Content-Type', 'application/json');
        response.send(JSON.stringify(f(thing, request, response), null, 2));
    };
};

/**
 */
var thing_thing = function (thing) {
    var base = "/api/things/" + thing.thing_id();

    return {
        "@id": base,
        "schema:name": thing.meta().get("schema:name"),
        "istate": base + "/ibase",
        "ostate": base + "/obase",
        "model": base + "/model",
        "meta": base + "/meta",
    };
};

/**
 */
var thing_istate = function (thing) {
    return _.extend(
        thing.state("istate"), {
            "@id": "/api/things/" + thing.thing_id() + "/istate",
        }
    );
};

/**
 */
var thing_ostate = function (thing) {
    return _.extend(
        thing.state("ostate"), {
            "@id": "/api/things/" + thing.thing_id() + "/ostate",
        }
    );
};

/**
 */
var thing_meta = function (thing) {
    return _.ld.compact(
        thing.state("meta"), {
            "@id": "/api/things/" + thing.thing_id() + "/meta",
        }
    );
};

/**
 */
var thing_model = function (thing) {
    var md = thing.state("model");

    md["@context"] = {
        "iot": _.ld.namespace["iot"],
        "iot-unit": _.ld.namespace["iot-unit"],
        "iot-attribute": _.ld.namespace["iot-attribute"],
        "schema": _.ld.namespace["schema"],
    };
    md["@id"] = "/api/things/" + thing.thing_id() + "/model";

    var meta = thing.meta();
    md._id = thing.thing_id();
    md._name = meta.get("schema:name");

    var ads = _.ld.list(md, "iot:attribute", []);
    for (var adi in ads) {
        var ad = ads[adi];
        ad._code = ad["@id"].replace(/^.*#/, '');
        ad._control = false;
        ad._reading = false;
        ad._name = _.ld.first(ad, "schema:name");

        var roles = _.ld.list(ad, 'iot:role');
        if (!roles) {
            ad._control = true;
            ad._reading = true;
        } else {
            for (var ri in roles) {
                var role = roles[ri];
                if (role === 'iot-attribute:role-control') {
                    ad._control = true;
                } else if (role === 'iot-attribute:role-reading') {
                    ad._reading = true;
                }
            }
        }

        interactors.assign_interactor_to_attribute(ad);
    }

    return md;
};

/*
 */
var things = function () {
    var tds = [];
    var things = iotdb.iot().things();

    for (var ti = 0; ti < things.length; ti++) {
        var thing = things[ti];
        var td = {};
        var tmodel = thing_model(thing);

        td["_id"] = tmodel._id;
        td["_name"] = tmodel._name;
        td["_sort"] = tmodel._name + "@@" + tmodel._id;
        td["_section"] = "things";
        td["model"] = tmodel;
        td["istate"] = thing_istate(thing);
        td["ostate"] = thing_ostate(thing);
        td["meta"] = thing_meta(thing);

        tds.push(td);
    }

    tds.sort(function (a, b) {
        if (a._sort < b._sort) {
            return -1;
        } else if (a._sort > b._sort) {
            return 1;
        } else {
            return 0;
        }
    });

    return tds;
};

/**
 *  MQTT messages - notifications, only on ISTATE and META 
 */
var _transport_mqtt = function(app, iotdb_transporter) {
    var mqtt_transporter = new MQTTTransport({
        prefix: path.join(settings.d.mqttd.prefix, "api", "things"),
        host: settings.d.mqttd.host,
        port: settings.d.mqttd.port,
    });
    iotdb.transporter.bind(iotdb_transporter, mqtt_transporter, {
        bands: ["meta", "istate", ],
    });
};

/**
 *  Express interface - get & put. Put only on META and OSTATE
 */
var _transport_express = function(app, iotdb_transporter) {
    var express_transporter = new ExpressTransport({
        prefix: path.join("/", "api", "things"),
    }, app);
    iotdb.transporter.bind(iotdb_transporter, express_transporter, {
        bands: ["meta", "istate", "ostate", "model", ],
        updated: ["meta", "ostate", ],
    });
}

/**
 *  This handles persisting metadata
 *  This probably needs work for dealing with @timestamp
 */
var _transport_metadata = function(app, iotdb_transporter) {
    var metadata_transporter = new FSTransport({
        prefix: ".iotdb/things",
    });

    // When things are changed, save their metata
    iotdb_transporter.updated(function(ud) {
        if (ud.band !== "meta") {
            return;
        }

        // thhe @timestamp means it had to be done by the user
        if (!ud.value['@timestamp']) {
            return;
        }

        metadata_transporter.update(ud);
    });

    // When things are discovered, load their metadata from the FS
    var _back_copy = function(ld) {
        if (ld.end) {
            return;
        } else if (ld.id) {
            metadata_transporter.get({
                id: ld.id, 
                band: "meta", 
            }, function(gd) {
                if (gd.value) {
                    iotdb_transporter.update(gd);
                }
            });
        }
    };

    iotdb_transporter.added(_back_copy);
    iotdb_transporter.list(_back_copy);
};

/**
 *  The Transporter will brodcast all istate/meta
 *  changes to Things to MQTT path 
 *  the same as the REST API
 */
var setup = function (app) {

    var iot = iotdb.iot();
    var things = iot.connect();

    exports.iotdb_transporter = new IOTDBTransport({}, things);

    _transport_mqtt(app, exports.iotdb_transporter);
    _transport_express(app, exports.iotdb_transporter);
    _transport_metadata(app, exports.iotdb_transporter);
};

/**
 *  API
 */
exports.setup = setup;

exports.thing_by_id = _thing_by_id;
exports.things = things;
exports.iotdb_transporter = null;
