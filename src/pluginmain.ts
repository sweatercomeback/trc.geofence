// TypeScript
// JScript functions for GeoFencing plugin.  
// This calls TRC APIs and binds to specific HTML elements from the page.
// Adapted from: https://raw.githubusercontent.com/hansy/trc-geofencing-plugin  

// This uses cluster Manager to handle a large number of pins
// see: https://github.com/googlemaps/js-marker-clusterer
// https://googlemaps.github.io/js-marker-clusterer/docs/reference.html 

import * as trc from '../node_modules/trclib/trc2';
import * as html from '../node_modules/trclib/trchtml';
import * as trcFx from '../node_modules/trclib/trcfx';
import * as trcPoly from '../node_modules/trclib/polygonHelper';

declare var $: any; // external definition for JQuery
declare var MarkerClusterer: any; // external definition 

declare var google: any; // external definition for google map 
declare var randomColor: any; // from randomColor()

// $$$ get from TRC
interface IGeoPoint {
    Lat: number;
    Long: number;
}

// List of partitions that we created.  
interface IPartition {
    sheetId: string;
    name: string;
    dataId: string; // data for the polygon 
    polygon: any; // google maps polygon
    infoWindow: any; // google Info window for displaying polygon name  
}

// Processed view on ISheetContents.
// - keeps only the data we need
// - ISheetContents is all string based. This can parse values
// - discard missing Lat/Long values.  
interface IRow {
    RecId: string;
    Lat: number;
    Long: number;
}

// Main plugin. 
export class MyPlugin {
    private _sheet: trc.Sheet;
    private _opts: trc.IPluginOptions;

    private _rows: IRow[];
    private _map: any;
    private _markers: any[]; // map markers; { recId: marker }
    private _partitions: { [id: string]: IPartition; }; // Map sheetId --> IPartition

    private _polyHelper: trcPoly.PolygonHelper;
    private _markerCluster: any;

    private _totalVisible: number; // Markers not yet assigned to a partition

    // $$$ find a way to avoid this.  
    private static _pluginId : string ="Geofencing.Beta";  

    // $$$ Move to PluginOptionsHelper? 
    private getGotoLinkSheet(sheetId : string ) : string {
        if (this._opts == undefined) {
            return "/"; // avoid a crash
        }
        return this._opts.gotoUrl + "/" + sheetId + "/" + 
            MyPlugin._pluginId  + "/index.html";
    } 

    // Entry point called from brower. 
    // This creates real browser objects and passes in. 
    public static BrowserEntry(
        sheet: trc.ISheetReference,
        opts: trc.IPluginOptions,
        next: (plugin: MyPlugin) => void
    ): void {
        var trcSheet = new trc.Sheet(sheet);
        // var opts2 = trc.PluginOptionsHelper.New(opts, trcSheet);
        
        // Do any IO here...
        html.Loading("prebody2");

        trcSheet.getInfo((info) => {
            trcSheet.getSheetContents((data) => {

                var polyHelper = new trcPoly.PolygonHelper(trcSheet);

                trcSheet.getChildren(children => {
                    var plugin = new MyPlugin(trcSheet, info, data, children, polyHelper, opts);
                    next(plugin);

                    // $$$ We shouldn't need a deferred timer here, but this invoke must come after the map finishes drawing else
                    // the google map doesn't render properly. Don't know why.
                    // It'd be great to get rid of the timer. 
                    setTimeout(() => plugin.FinishInit(
                        () => {
                            $("#prebody2").hide();
                        }
                    ), 3000);
                });
            });
        });
    }

    // Create TRC filter expression to refer to this polygon 
    private static CreateFilter(dataId: string): string {
        return "IsInPolygon('" + dataId + "',Lat,Long)";
    }

    // Reverse of CreateFilter expression. Gets the DataId back out. 
    // Returns null if not found
    public static GetPolygonIdFromFilter(filter: string): string {
        var n = filter.match(/IsInPolygon.'(.+)',Lat,Long/i);
        if (n == null) {
            return null;
        }
        var dataId = n[1];
        return dataId;
    }

    // Performance note: Do all the UI upfront and then do all the map updates (add polygons, etc). 
    // It's a *huge* performance penalty to interleave them because it prevents map rendering
    // from being batched up and done all at once.  
    private BuildPartitions(
        children: trc.IGetChildrenResultEntry[],
        callback: () => void
    ): void {
        var _missing = 0;
        var _extra: any = {};
        var remaining = children.length;

        // Second pass. After we collect all the IO, then update the map. 
        var next = () => {
            remaining--;
            if (remaining == 0) {
                for (var sheetId in this._partitions) {
                    var partition = this._partitions[sheetId];
                    var polySchema = _extra[sheetId].polySchema;
                    var count = _extra[sheetId].count;

                    partition.polygon = MyPlugin.newPolygon(polySchema, this._map);
                    this.physicallyAddPolygon(
                        partition.name,
                        partition.polygon,
                        count,
                        partition.sheetId);
                }


                callback();
            }
        };

        if (children.length == 0) 
        {
            remaining = 1;
            next();
            return;
        }

        // Do the first pass for all IO. 
        // Dispatch IO in parallel. 
        for (var i = 0; i < children.length; i++) {
            var _child = children[i];

            ((child: trc.IGetChildrenResultEntry) => {
                var sheetId = child.Id;
                var childSheet = this._sheet.getSheetById(sheetId);
                childSheet.getInfo(childInfo => {
                    var filter = child.Filter;
                    var dataId = MyPlugin.GetPolygonIdFromFilter(filter);
                    if (dataId == null) {
                        // there are child sheets without polygon data. Warn!!
                        _missing++;
                        next();
                    } else {
                        this._polyHelper.getPolygonById(dataId, (polySchema) => {
                            if (polySchema == null) {
                                _missing++;
                            }
                            else {
                                _extra[sheetId] = {
                                    polySchema: polySchema,
                                    count: childInfo.CountRecords
                                };
                                this._partitions[sheetId] = {
                                    sheetId: sheetId,
                                    name: child.Name,
                                    dataId: dataId,
                                    polygon: null, // fill in later.      
                                    infoWindow: null
                                };
                            }
                            next();
                        });
                    }
                });
            })(_child); // closure
        }
    }




    private FinishInit(callback: () => void): void {
        var other = 0;
        // Get existing child sheets
        this._sheet.getChildren(children => {
            this.BuildPartitions(children, () => {
                this.updateClusterMap();
                callback();
            });
        });
    }

    private static parseSheetContents(data: trc.ISheetContents): IRow[] {
        var colRecId = data["RecId"];
        var colLat = data["Lat"];
        var colLong = data["Long"];

        var result: IRow[] = [];
        var numRows = colRecId.length;

        for (var i = 0; i < numRows; i++) {
            var id = colRecId[i];
            var strlat = colLat[i];
            var strlng = colLong[i];

            var lat = parseFloat(strlat);
            var lng = parseFloat(strlng);

            if (isNaN(lat) || isNaN(lng)) {
                continue;
            }

            result.push({
                RecId: id,
                Lat: lat,
                Long: lng
            });
        }
        return result;
    }

    public constructor(
        sheet: trc.Sheet,
        info: trc.ISheetInfoResult,
        data: trc.ISheetContents,
        children: trc.IGetChildrenResultEntry[],
        polyHelper: trcPoly.PolygonHelper,
        opts: trc.IPluginOptions
    ) {
        this._sheet = sheet;
        this._rows = MyPlugin.parseSheetContents(data);
        this._map = this.initMap(info.Latitute, info.Longitude);
        this._markers = [];
        this._partitions = {};
        this._polyHelper = polyHelper;
        this._opts = opts;

        this.addMarkers();
        this.initDrawingManager(this._map); // adds drawing capability to map

        this._markerCluster = new MarkerClusterer(
            this._map,
            [], { imagePath: 'https://cdn.rawgit.com/googlemaps/js-marker-clusterer/gh-pages/images/m' });

        // Loading existing children will happen in FinishInit()
    }

    // https://developers.google.com/maps/documentation/javascript/examples/polygon-simple
    static newPolygon(schema: trc.IPolygonSchema, map: any): any {
        var coords: any = [];
        for (var i = 0; i < schema.Lat.length; i++) {
            coords.push({
                lat: schema.Lat[i],
                lng: schema.Long[i]
            })
        }

        var polygon = new google.maps.Polygon({
            paths: coords,
            strokeColor: '#FF0000',
            strokeOpacity: 0.8,
            strokeWeight: 2,
            fillColor: '#FF0000',
            fillOpacity: 0.35,
            editable: true
        });
        polygon.setMap(map);

        return polygon;
    }

    // https://developers.google.com/maps/documentation/javascript/examples/polygon-arrays
    // Convert a google polgyon to a TRC array
    static getVertices(polygon: any): IGeoPoint[] {
        var vertices = polygon.getPath();

        var result: IGeoPoint[] = [];

        for (var i = 0; i < vertices.getLength(); i++) {
            var xy = vertices.getAt(i);
            result.push({ Lat: xy.lat(), Long: xy.lng() });
        }
        return result;
    }


    // add drawing capability to map
    private initDrawingManager(map: any) {
        var drawingManager = new google.maps.drawing.DrawingManager({
            drawingMode: google.maps.drawing.OverlayType.POLYGON,
            drawingControlOptions: {
                position: google.maps.ControlPosition.TOP_CENTER,
                drawingModes: [
                    google.maps.drawing.OverlayType.POLYGON
                ]
            },
            polygonOptions: {
                editable: true
            }
        });

        // add event listener for when shape is drawn
        google.maps.event.addListener(drawingManager, 'overlaycomplete', (event: any) => {
            var polygon = event.overlay;
            var countInside = this.countNumberInPolygon(polygon);

            if (countInside === 0) {
                alert("No records found in polygon");
                event.overlay.setMap(null); // remove polygon
            } else {
                var walklistName = prompt("Name of walklist");

                if (walklistName === null) {
                    event.overlay.setMap(null); // remove polygon
                } else if (walklistName === "") {
                    alert("Walklist name can't be empty");
                    event.overlay.setMap(null);
                } else {
                    this.createWalklist(walklistName, countInside, polygon);
                }

            }
        });

        drawingManager.setMap(map);
    }


    // function to be returned in the event a checkbox is clicked
    private assignedCheckboxClickFx(sheetId: string) {
        /*
        var outer = this;
        return function (event: any) {
            if (this.checked) {
                outer.setMarkersOpacity(sheetId, 0.2);
                outer.setPolygonOpacity(sheetId, 0.2);
            } else {
                outer.setMarkersOpacity(sheetId, 1);
                outer.setPolygonOpacity(sheetId, 1);
            }
        };*/
    }

    // remove polygon/polyline from global var _polygons
    private removeGlobalPolygon(sheetId: string) {
        var partition = this._partitions[sheetId];

        var infoWindow = partition.infoWindow;
        if (infoWindow != null) {
            infoWindow.close();
        }

        var polygon = partition.polygon;
        polygon.setMap(null);
        delete this._partitions[sheetId];
    }

    // remove walklist from sidebar
    private removeWalklist(sheetId: string) {
        var tr = document.getElementById(sheetId);
        tr.parentNode.removeChild(tr);
    }

    // function to be returned when delete 'x' is clicked
    private deleteWalklistClickFx(sheetId: string) {
        return (event: any) => {
            var remove = confirm("Do you wish to delete this walklist?");

            if (remove) {
                var partition = this._partitions[sheetId];
                this._sheet.deleteChildSheet(sheetId, () => {
                    this._sheet.deleteCustomData(trc.PolygonKind, partition.dataId, () => {
                        {
                            this.removeWalklist(sheetId);
                            this.removeGlobalPolygon(sheetId);
                            this.showMarkers(partition.polygon);
                            this.updateClusterMap();
                        };
                    });
                });
            }
        }
    }

    // add walklist to sidebar
    private appendWalklist(partitionName: string, sheetId: string, count: number, color: any) {
        var tr = document.createElement('tr');
        tr.setAttribute('style', 'border-left: 10px solid ' + color);
        tr.setAttribute('id', sheetId);

        // add name column
        var tdName = document.createElement('td');
        var gotoUrl = this.getGotoLinkSheet(sheetId);
        tdName.innerHTML = "<a target='_blank' href='" + gotoUrl + "'>"  + partitionName + "</a>";
        tr.appendChild(tdName);

        // add record count column
        

        var tdCount = document.createElement('td');
        tdCount.innerHTML = count.toString();
        tdCount.setAttribute('class', 'record-count');
        tr.appendChild(tdCount);

        // add delete column
        var tdDelete = document.createElement('td');
        tdDelete.innerHTML = "x";
        tdDelete.setAttribute('class', 'delete-walklist-btn');
        tdDelete.onclick = this.deleteWalklistClickFx(sheetId);
        tr.appendChild(tdDelete);

        var walklistsEl = document.getElementById('walklists');
        var tbody = walklistsEl.getElementsByTagName('tbody')[0];

        tbody.appendChild(tr);

        // $('#walklists').append("<tr style='border-left: 10px solid "+color+"' id='"+sheetId+"'><td>"+name+"</td><td>"+count+"</td><td><input type='checkbox'></td></tr>")
    }

    // Called when we finish drawing a polygon and confirmed we want to create a walklist. 
    private createWalklist(partitionName: string, countInside: number, polygon: any) {
        var vertices = MyPlugin.getVertices(polygon);
        this._polyHelper.createPolygon(partitionName, vertices, (dataId) => {

            var filter = MyPlugin.CreateFilter(dataId);
            this._sheet.createChildSheetFromFilter(partitionName, filter, false, (childSheet: trc.Sheet) => {
                var sheetId = childSheet.getId();

                this._partitions[sheetId] = {
                    sheetId: sheetId,
                    name: partitionName,
                    dataId: dataId,
                    polygon: polygon,
                    infoWindow: null // assign later
                };

                this.physicallyAddPolygon(partitionName, polygon, countInside, sheetId);
                this.updateClusterMap();
            });
        });
    }

    // Helper to get the center of a polygon. Useful for adding a label.
    // http://stackoverflow.com/questions/3081021/how-to-get-the-center-of-a-polygon-in-google-maps-v3
    private static polygonCenter(poly: any): any {
        var lowx: number,
            highx: number,
            lowy: number,
            highy: number,
            lats: number[] = [],
            lngs: number[] = [],
            vertices = poly.getPath();

        for (var i = 0; i < vertices.length; i++) {
            lngs.push(vertices.getAt(i).lng());
            lats.push(vertices.getAt(i).lat());
        }

        lats.sort();
        lngs.sort();
        lowx = lats[0];
        highx = lats[vertices.length - 1];
        lowy = lngs[0];
        highy = lngs[vertices.length - 1];
        var center_x = lowx + ((highx - lowx) / 2);
        var center_y = lowy + ((highy - lowy) / 2);
        return (new google.maps.LatLng(center_x, center_y));
    }

    private physicallyAddPolygon(partitionName: string, polygon: any, count: number, sheetId: string): void {
        var color = randomColor();

        //this.addPolygonResizeEvents(polygon, sheetId);
        this.fillPolygon(polygon, color);
        this.appendWalklist(partitionName, sheetId, count, color);
        this.hideMarkers(polygon);
        this.addPolygonResizeEvents(polygon, sheetId);

        // Add a label to the polygon. 
        var location = MyPlugin.polygonCenter(polygon);
        var infoWindow = new google.maps.InfoWindow({
            content: partitionName + "(" + count + ")",
            position: location
        });
        infoWindow.open(this._map);
        this._partitions[sheetId].infoWindow = infoWindow;
    }

    private updateCounterText(): void {
        var total = this._markers.length;
        var numAssigned = this._markers.length - this._totalVisible;
        var perAssigned = Math.round(numAssigned * 100 / total);

        var msg = total + " total records. " + numAssigned + " (" + perAssigned + "%) have been assigned to a partition. "
            + this._totalVisible + " records are not yet assigned.";
        $("#counters").text(msg);
    }

    // helper to invoke predicate on each point inside the polygon
    private forEachInPolygin(
        polygon: any,
        predicate: (idx: number) => void
    ): void {
        var numRows = this._rows.length;

        for (var i = 0; i < numRows; i++) {
            var row = this._rows[i];
            var lat = row.Lat;
            var lng = row.Long;

            if (this.isInsidePolygon(lat, lng, polygon)) {
                predicate(i);
            }
        }
    }

    private countNumberInPolygon(polygon: any): number {
        var total = 0;
        this.forEachInPolygin(polygon,
            (idx) => {
                total++;
            });
        return total;
    }

    private showMarkers(polygon: any): void {
        this.forEachInPolygin(polygon,
            (idx) => {
                var marker = this._markers[idx];

                if (!marker.xvisible) {
                    marker.xvisible = true;
                }
            });
    }

    private hideMarkers(polygon: any): void {
        this.forEachInPolygin(polygon,
            (idx) => {
                var marker = this._markers[idx];

                if (marker.xvisible) {
                    marker.xvisible = false;
                }
            });
    }

    private fillPolygon(polygon: any, color: any) {
        polygon.setOptions({
            fillColor: color,
            fillOpacity: .35
        });
    }


    // $$$ This should be migrated to just update the Polygon Data. 
    // Then rerunning the filter will pick up the new boundary 
    private updatePolygonBoundary(sheetId: string) {
        var partition = this._partitions[sheetId];
        var polygon = partition.polygon;
        var vertices = MyPlugin.getVertices(polygon);

        this._polyHelper.updatePolygon(partition.dataId, partition.name, vertices,
            (dataId: string) => {
                // $$$ - UI update.If we shrink the polygon, we should add back old markers.
                // If we shrunk, show old values. (like a delete)
                // If we grew, show new values. 
                this.hideMarkers(polygon);
                this.updateClusterMap();
            });
    }


    // event listeners for when polygon shape is modified
    private addPolygonResizeEvents(polygon: any, sheetId: string) {
        google.maps.event.addListener(polygon.getPath(), 'set_at', () => {
            this.updatePolygonBoundary(sheetId);
        });

        google.maps.event.addListener(polygon.getPath(), 'insert_at', () => {
            this.updatePolygonBoundary(sheetId);
        });
    }





    // returns true if lat/lng coordinates are inside drawn polygon,
    // false otherwise
    private isInsidePolygon(lat: any, lng: any, poly: any) {
        var coords = new google.maps.LatLng(lat, lng);

        var result = google.maps.geometry.poly.containsLocation(coords, poly);
        return result;
    }

    // Initialize Google Map
    private initMap(lat: number, lng: number) {
        var coords = new google.maps.LatLng(lat, lng);

        var mapOptions = {
            zoom: 16,
            center: coords,
            mapTypeId: google.maps.MapTypeId.ROADMAP
        };

        var mapEl = document.getElementById("map");
        // need to give element height for GMap to render, so add 'map' CSS
        // class which has height rule
        mapEl.setAttribute('class', 'map');

        var gmap = new google.maps.Map(mapEl, mapOptions);

        return gmap;
    }

    // loops through sheet records, passing their lat/lng 
    // to 'addMarker' function
    private addMarkers() {
        var records = this._rows.length;

        for (var i = 0; i < records; i++) {
            var row = this._rows[i];
            var recId = row.RecId;
            var lat = row.Lat;
            var lng = row.Long;

            var latLng = new google.maps.LatLng(lat, lng);
            var marker = new google.maps.Marker({
                position: latLng,
                id: recId,
                xvisible: true, // custom field
            });
            // Don't set marker.map since this will be part of the clusterManager.
            this._markers.push(marker);
        }
    }

    // Update map to show markers set to visible. 
    // Markers that are already in a polygon are not visible.     
    private updateClusterMap() {
        this._totalVisible = 0;
        this._markerCluster.clearMarkers();

        var visibleMarkers: any[] = [];
        for (var i = 0; i < this._markers.length; i++) {
            var marker = this._markers[i];
            if (marker.xvisible) {
                visibleMarkers.push(marker);
                this._totalVisible++;
            }
        }
        this._markerCluster.addMarkers(visibleMarkers);

        this.updateCounterText();
    }
}
