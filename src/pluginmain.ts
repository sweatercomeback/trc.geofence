// TypeScript
// JScript functions for GeoFencing plugin.  
// This calls TRC APIs and binds to specific HTML elements from the page.
// Adapted from: https://raw.githubusercontent.com/hansy/trc-geofencing-plugin  

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

// List of child records 
interface IChildRecord {
    sheetId: string;
    name: string;
    dataId: string; // data for the polygon 
    polygon: any; // google maps polygon 
}

export class MyPlugin {
    private _sheet: trc.Sheet;
    private _options: trc.PluginOptionsHelper;

    private _info: trc.ISheetInfoResult;
    private _data: trc.ISheetContents;
    private _map: any;
    private _markers: any[]; // map markers; { recId: marker }
    private _partitions: { [id: string]: IChildRecord; }; // Map sheetId --> IChildRecord

    private _polyHelper: trcPoly.PolygonHelper;
    private _markerCluster: any;


    // Entry point called from brower. 
    // This creates real browser objects and passes in. 
    public static BrowserEntry(
        sheet: trc.ISheetReference,
        opts: trc.IPluginOptions,
        next: (plugin: MyPlugin) => void
    ): void {
        var trcSheet = new trc.Sheet(sheet);
        var opts2 = trc.PluginOptionsHelper.New(opts, trcSheet);

        // Do any IO here...

        trcSheet.getInfo((info) => {
            trcSheet.getSheetContents((data) => {

                var polyHelper = new trcPoly.PolygonHelper(trcSheet);

                trcSheet.getChildren(children => {
                    var plugin = new MyPlugin(trcSheet, info, data, children, polyHelper);
                    next(plugin);

                    // $$$ We shouldn't need a deferred timer here, but this invoke must come after the map finishes drawing else
                    // the google map doesn't render properly. Don't know why.
                    // It'd be great to get rid of the timer. 
                    setTimeout(() => plugin.FinishInit(null), 3000);
                });
            });
        });
    }

    // Load existing sheets and draw the polygons 
    private FinishInit(callback: () => void): void {
        // Get existing child sheets
        this._sheet.getChildren(children => {
            for (var i = 0; i < children.length; i++) {
                var child = children[i];
                this.Init2Worker(child);
            }
        });
    }

    // Populate 1 partition (draw the polygon, data structures, etc) 
    private Init2Worker(child: trc.IGetChildrenResultEntry): void {
        this._polyHelper.lookupNameFromId(child.Name, (dataId) => {
            // Is it a polygon?
            if (dataId != null) {
                var childSheet = this._sheet.getSheetById(child.Id);
                childSheet.getInfo(childInfo => {
                    this._polyHelper.getPolygonById(dataId, (polySchema) => {
                        var polygon = MyPlugin.newPolygon(polySchema, this._map);

                        var sheetId = child.Id;
                        this._partitions[sheetId] = {
                            sheetId: sheetId,
                            name: child.Name,
                            dataId: dataId,
                            polygon: polygon
                        };

                        this.physicallyAddPolygon(child.Name, polygon, childInfo.CountRecords, dataId);
                    });
                });
            }
        });
    }

    public constructor(
        sheet: trc.Sheet,
        info: trc.ISheetInfoResult,
        data: trc.ISheetContents,
        children: trc.IGetChildrenResultEntry[],
        polyHelper: trcPoly.PolygonHelper
    ) {
        this._sheet = sheet;
        this._data = data;
        this._info = info;
        this._map = this.initMap(info.Latitute, info.Longitude);
        this._markers = [];
        this._partitions = {};
        this._polyHelper = polyHelper;

        this.addMarkers();
        this.initDrawingManager(this._map); // adds drawing capability to map

        this._markerCluster = new MarkerClusterer(
            this._map,
            this._markers, { imagePath: 'https://cdn.rawgit.com/googlemaps/js-marker-clusterer/gh-pages/images/m' });

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
            fillOpacity: 0.35
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
            var recIds = this.getPolygonIds(polygon);

            if (recIds.length === 0) {
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
                    this.createWalklist(walklistName, recIds, polygon);
                }

            }
        });

        drawingManager.setMap(map);
    }


    // function to be returned in the event a checkbox is clicked
    private assignedCheckboxClickFx(sheetId: string) {
        var outer = this;
        return function (event: any) {
            if (this.checked) {
                outer.setMarkersOpacity(sheetId, 0.2);
                outer.setPolygonOpacity(sheetId, 0.2);
            } else {
                outer.setMarkersOpacity(sheetId, 1);
                outer.setPolygonOpacity(sheetId, 1);
            }
        };
    }



    // remove polygon/polyline from global var _polygons
    private removeGlobalPolygon(sheetId: string) {
        var polygon = this._partitions[sheetId].polygon;
        polygon.setMap(null);
        delete this._partitions[sheetId];
    }

    // remove walklist from sidebar
    private removeWalklist(sheetId: string) {
        var tr = document.getElementById(sheetId);
        tr.parentNode.removeChild(tr);
    }

    // unassign marker from child sheet
    private removeMarkerSheetId(sheetId: string) {
        for (var id in this._markers) {
            var marker = this._markers[id];
            if (marker.sheetId === sheetId) {
                marker.sheetId = "";
            }
        }
    }

    private setMarkersOpacity(sheetId: string, opacity: number) {
        for (var id in this._markers) {
            var marker = this._markers[id];
            if (marker.sheetId === sheetId) {
                marker.setOpacity(opacity);
            }
        }
    }

    private setPolygonOpacity(sheetId: string, opacity: number) {
        var polygon = this._partitions[sheetId].polygon;
        polygon.setOptions({ strokeOpacity: opacity });
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
                            this.removeMarkerSheetId(sheetId);
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
        tdName.innerHTML = partitionName;
        tr.appendChild(tdName);

        // add record count column
        var tdCount = document.createElement('td');
        tdCount.innerHTML = count.toString();
        tdCount.setAttribute('class', 'record-count');
        tr.appendChild(tdCount);

        // add assigned checkbox column
        var tdCheckbox = document.createElement('td');
        var checkbox = document.createElement('input');
        checkbox.setAttribute('type', 'checkbox');
        checkbox.onclick = this.assignedCheckboxClickFx(sheetId);
        tdCheckbox.appendChild(checkbox);
        tr.appendChild(tdCheckbox);

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
    private createWalklist(partitionName: string, ids: string[], polygon: any) {
        var vertices = MyPlugin.getVertices(polygon);
        this._polyHelper.createPolygon(partitionName, vertices, (dataId) => {

            var filter = "IsInPolygon('" + dataId + "',Lat,Long)";
            this._sheet.createChildSheetFromFilter(partitionName, filter, false, (childSheet: trc.Sheet) => {
                //alert('Yay! Poly saved:' + dataId);
                //var sheetId = childSheetRef.SheetId;
                var sheetId = childSheet.getId();

                this._partitions[sheetId] = {
                    sheetId: sheetId,
                    name: partitionName,
                    dataId: dataId,
                    polygon: polygon
                };

                this.physicallyAddPolygon(name, polygon, ids.length, sheetId);

                //this.addPolygonResizeEvents(polygon, sheetId);
                //this.fillPolygon(polygon, color);
                //this.globallyAddPolygon(polygon, sheetId);
                //this.appendWalklist(name, sheetId, ids.length, color);
                this.updateMarkersWithSheetId(ids, sheetId);
            });
        });
    }

    private physicallyAddPolygon(partitionName: string, polygon: any, count: number, sheetId: string): void {
        var color = randomColor();

        //this.addPolygonResizeEvents(polygon, sheetId);
        this.fillPolygon(polygon, color);
        this.appendWalklist(partitionName, sheetId, count, color);
        //this.updateMarkersWithSheetId(ids, sheetId); $$$
    }

    // add child sheet id to markers with lat/lng inside walklist
    private updateMarkersWithSheetId(ids: string[], sheetId: string) {
        var total = ids.length;

        this._markers.forEach(function (item) {
            item.sheetId = sheetId;
        })
    }

    private fillPolygon(polygon: any, color: any) {
        polygon.setOptions({
            fillColor: color,
            fillOpacity: 1
        });
    }

    /*
    // $$$ This should be migrated to just update the Polygon Data. 
    // Then rerunning the filter will pick up the new boundary 
        private updateWalklist(ids: string[], sheetId: string) {        
            trcPatchChildSheetRecIds(_sheet, sheetId, ids, function() {
                updateRecordNum(sheetId, ids.length);
            });        
        }
    
    
        // event listeners for when polygon shape is modified
        private addPolygonResizeEvents(polygon: any, sheetId: string) {
            //alert("Poly resize is called"); // $$$
    
            google.maps.event.addListener(polygon.getPath(), 'set_at', () => {
                this.updateWalklist(this.getPolygonIds(polygon), sheetId);
            });
    
            google.maps.event.addListener(polygon.getPath(), 'insert_at', () => {
                this.updateWalklist(this.getPolygonIds(polygon), sheetId);
            });
        }
    */

    // return rec ids within a polygon
    private getPolygonIds(polygon: any): string[] {
        var ids: string[] = [];
        var numRows = this._info.CountRecords;

        for (var i = 0; i < numRows; i++) {
            var id = this._data["RecId"][i];
            var lat = this._data["Lat"][i];
            var lng = this._data["Long"][i];

            if (this.isInsidePolygon(lat, lng, polygon)) {
                ids.push(id);
            }
        }

        return ids;
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
        var records = this._info.CountRecords;

        for (var i = 0; i < records; i++) {
            var recId = this._data["RecId"][i];
            var lat = this._data["Lat"][i];
            var lng = this._data["Long"][i];

            this.addMarker(lat, lng, recId);
        }
    }

    // adds map marker based on last/lng
    private addMarker(lat: any, lng: any, recId: string) {
        var latLng = new google.maps.LatLng(lat, lng);
        var marker = new google.maps.Marker({
            position: latLng,
            id: recId,
            sheetId: ""
        });
        // Don't set marker.map since this will be part of the clusterManager. 

        //this._markers[recId] = marker;
        this._markers.push(marker);
    }



}
