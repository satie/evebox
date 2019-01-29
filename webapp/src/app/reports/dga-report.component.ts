import {Component, OnDestroy, OnInit} from "@angular/core";
import {ElasticSearchService} from '../elasticsearch.service';
import {ReportsService} from "./reports.service";
import {AppService, AppEventCode} from "../app.service";
import {EveboxFormatIpAddressPipe} from "../pipes/format-ipaddress.pipe";
import {EveboxSubscriptionTracker} from "../subscription-tracker";
import {ActivatedRoute, Params, Router} from "@angular/router";
import {ApiService, ReportAggOptions} from "../api.service";
import {TopNavService} from "../topnav.service";

import * as moment from "moment";
import { query } from "@angular/animations";

@Component({
    template: `
      <div class="content" [ngClass]="{'evebox-opacity-50': loading > 0}">

        <br/>
        
        <loading-spinner [loading]="loading > 0"></loading-spinner>

        <div class="row">
          <div class="col-md">
            <button type="button" class="btn btn-secondary" (click)="refresh()">
              Refresh
            </button>
          </div>
          <div class="col-md">
            <evebox-filter-input [queryString]="queryString"></evebox-filter-input>
          </div>
        </div>

        <br/>

        <metrics-graphic *ngIf="eventsOverTime"
                         graphId="dnsRequestsOverTime"
                         title="DNS Requests Over Time (w/DGA Score)"
                         [data]="eventsOverTime"></metrics-graphic>

        <div class="row">
          <div class="col-md-6">
            <report-data-table *ngIf="topDGAscores"
                               title="Top DGA Scores"
                               [rows]="topDGAscores"
                               [headers]="['Score', 'RRName']"></report-data-table>
          </div>
          <div class="col-md-6">
            <report-data-table *ngIf="topDomains"
                               title="Top Domains"
                               [rows]="topDomains"
                               [headers]="['#', 'Domain']"></report-data-table>
          </div>          
        </div>

        <br/>

        <div class="row">

          <div class="col-md-6">
            <report-data-table *ngIf="topServers"
                               title="Top DNS Servers"
                               [rows]="topServers"
                               [headers]="['#', 'Server']"></report-data-table>
          </div>

          <div class="col-md-6">
            <report-data-table *ngIf="topClients"
                               title="Top DNS Clients"
                               [rows]="topClients"
                               [headers]="['#', 'Client']"></report-data-table>
          </div>

        </div>

        <br/>

        <div class="row">
          <div class="col-md-6">
            <report-data-table *ngIf="topRrtypes"
                               title="Top Requests Types"
                               [rows]="topRrtypes"
                               [headers]="['#', 'RRType']"></report-data-table>
          </div>
          <div class="col-md-6">
            <report-data-table *ngIf="topRcodes"
                               title="Top Response Codes"
                               [rows]="topRcodes"
                               [headers]="['#', 'RCode']"></report-data-table>
          </div>
        </div>

        <br/>

      </div>`,
})
export class DGAReportComponent implements OnInit, OnDestroy {

    eventsOverTime: any[];

    topDGAscores: any[];
    topDomains: any[];
    topRrtypes: any[];
    topRcodes: any[];
    topServers: any[];
    topClients: any[];

    loading = 0;

    defaultQuerystringFilter = "_exists_:analytics.dga.score";
    queryString = "";

    subTracker: EveboxSubscriptionTracker = new EveboxSubscriptionTracker();

    constructor(private router: Router, 
                private route: ActivatedRoute,
                private elasticsearch: ElasticSearchService,
                private reports: ReportsService,
                private appService: AppService,
                private api: ApiService,
                private topNavService: TopNavService,
                private reportsService: ReportsService,
                private formatIpAddressPipe: EveboxFormatIpAddressPipe) {
    }

    ngOnInit() {

        this.subTracker.subscribe(this.route.params, (params: Params) => {
            this.queryString = params["q"] || "";
            this.refresh();
        });

        this.subTracker.subscribe(this.appService, (event: any) => {
            if (event.event == AppEventCode.TIME_RANGE_CHANGED) {
                this.refresh();
            }
        });

    }

    ngOnDestroy() {
        this.subTracker.unsubscribe();
    }

    mapAddressAggregation(items: any[]) {
        return items.map((item: any) => {

            let key = item.key;

            // If key looks like an IP address, format it.
            if (key.match(/\d*\.\d*\.\d*\.\d*/)) {
                key = this.formatIpAddressPipe.transform(key);
            }

            return {
                key: key,
                count: item.doc_count,
            };

        });
    }

    mapAggregation(items: any[]) {
        return items.map((item: any) => {
            return {
                key: item.key,
                count: item.doc_count,
            };
        });
    }


    load(fn: any) {
        this.loading++;
        fn().then(() => {
        }).catch((err) => {
        }).then(() => {
            this.loading--;
        })
    }

    refresh() {

        let size = 20;
        let range = this.topNavService.getTimeRangeAsSeconds();
        let now = moment();

        let query = this.topDGAScoresQuery(this.queryString, size);        

        this.elasticsearch.addTimeRangeFilter(query, now, range);

        this.elasticsearch.search(query).then((response: any) => {
            // console.log(response);
            this.topDGAscores = response.hits.hits.map((hit: any) => {
                return {
                    key: hit._source.dns.rrname,
                    count: Number.parseFloat(hit._source.analytics.dga.score).toFixed(3)
                }
            });            
            this.loading--;
        });

        let aggOptions: ReportAggOptions = {
            eventType: "dns",
            dnsType: "answer",
            timeRange: range,
            queryString: this.buildQuerystring(this.queryString),
            size: size,
        };

        this.load(() => {
            return this.api.reportAgg("dns.rcode", aggOptions)
                .then((response: any) => {                    
                    this.topRcodes = response.data;
                });
        });

        this.load(() => {
            return this.api.reportAgg("dns.rrname", aggOptions)
                .then((response: any) => {                    
                    this.topDomains = response.data;
                });
        });

        // Switch to request queries.
        // aggOptions.dnsType = "query";

        this.load(() => {
            return this.api.reportAgg("dns.answers.rrtype", aggOptions)
                .then((response: any) => {                    
                    this.topRrtypes = response.data;
                });
        });

        this.load(() => {
            return this.api.reportAgg("src_ip", aggOptions)
                .then((response: any) => {
                    this.topClients = response.data;
                });
        });

        this.load(() => {
            return this.api.reportAgg("dest_ip", aggOptions)
                .then((response: any) => {
                    this.topServers = response.data;
                });
        });

        // Queries over time histogram.
        this.load(() => {
            return this.api.reportHistogram({
                timeRange: range,
                interval: this.reportsService.histogramTimeInterval(range),
                eventType: "dns",
                dnsType: "answer",
                queryString: this.buildQuerystring(this.queryString),
            }).then((response: any) => {
                this.eventsOverTime = response.data.map((x: any) => {
                    return {
                        date: moment(x.key).toDate(),
                        value: x.count
                    };
                });
            });
        });

    }

    buildQuerystring(qs: string) {
        if (qs != "") {
            return this.defaultQuerystringFilter + " AND " + qs;
        }
        return this.defaultQuerystringFilter;
    }

    topDGAScoresQuery(qs: string, size: number) {
        let query_string = "dns.type:ANSWER AND !(dns.rcode:NXDOMAIN)";
        if (qs) {
            query_string += " AND " + qs;
        }
        let query = 
        {
            query: {
                bool: {
                    filter: [
                        {
                            exists: {
                                field: "analytics.dga.score"
                            }
                        },
                        {
                            query_string: {
                                query: query_string
                            }
                        }
                    ]
                }
            },
            sort: [
                {
                    "analytics.dga.score": {
                        order: "desc"
                    }
                }
            ],
            size: size,
            aggs : {
                distinct_rrname : {
                    cardinality : {
                      field : "dns.rrname" 
                    }
                }
            }
        };
        return query;
    }
}